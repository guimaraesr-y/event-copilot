#!/usr/bin/env sh
set -eu

N8N_READY_WAIT_SECONDS="${N8N_READY_WAIT_SECONDS:-30}"

sync_workflow() {
  id="$1"
  file="$2"
  label="$3"

  printf 'Importing %s... ' "$label"
  docker compose exec -T n8n n8n import:workflow --input="$file" >/dev/null
  echo OK

  printf 'Publishing %s... ' "$label"
  docker compose exec -T n8n n8n publish:workflow --id="$id" >/dev/null
  echo OK
}

sync_workflow "eccDomainEventGw1" "/files/n8n/workflows/ecc-domain-event-gateway.json" "ECC Domain Event Gateway"

# n8n CLI publication updates the database. Restart the runtime once after all
# imports so production webhooks are registered from the published versions.
printf 'Restarting n8n to register production webhooks... '
docker compose restart n8n >/dev/null
echo OK

printf 'Waiting for n8n process readiness... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$N8N_READY_WAIT_SECONDS" ]; do
  if docker compose exec -T n8n node -e \
    "fetch('http://127.0.0.1:5678/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    echo OK
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [ "$ATTEMPT" -ge "$N8N_READY_WAIT_SECONDS" ]; then
  echo "n8n did not become ready after ${N8N_READY_WAIT_SECONDS}s"
  docker compose logs --tail=100 n8n || true
  exit 1
fi

# /healthz can become ready before published production webhooks are registered.
# Probe the production path itself. A registered workflow may reject this dummy
# envelope with 4xx/5xx; the only state we reject here is n8n's webhook 404.
printf 'Waiting for production webhook registration... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$N8N_READY_WAIT_SECONDS" ]; do
  if docker compose exec -T n8n node -e '
    fetch("http://127.0.0.1:5678/webhook/ecc-domain-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then(async (r) => {
      const text = await r.text();
      const missing = r.status === 404 && (
        text.includes("not registered") ||
        text.includes("Cannot POST /webhook/ecc-domain-events")
      );
      process.exit(missing ? 1 : 0);
    }).catch(() => process.exit(1));
  ' >/dev/null 2>&1; then
    echo OK
    exit 0
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

echo "n8n production webhook was not registered after ${N8N_READY_WAIT_SECONDS}s"
docker compose logs --tail=120 n8n || true
exit 1
