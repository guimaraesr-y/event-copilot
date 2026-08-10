#!/usr/bin/env sh
set -eu

WORKFLOW_ID="eccDomainEventGw1"
WORKFLOW_FILE="/files/n8n/workflows/ecc-domain-event-gateway.json"
N8N_READY_WAIT_SECONDS="${N8N_READY_WAIT_SECONDS:-30}"

printf 'Importing ECC Domain Event Gateway... '
MSYS_NO_PATHCONV=1 docker compose exec -T n8n n8n import:workflow --input="$WORKFLOW_FILE" >/dev/null
echo OK

printf 'Publishing ECC Domain Event Gateway... '
MSYS_NO_PATHCONV=1 docker compose exec -T n8n n8n publish:workflow --id="$WORKFLOW_ID" >/dev/null
echo OK

# n8n's server CLI writes publish/unpublish changes directly to the database.
# When the main n8n process is already running, production triggers/webhooks are
# not re-registered until that process restarts.
printf 'Restarting n8n to register production webhooks... '
docker compose restart n8n >/dev/null
echo OK

printf 'Waiting for n8n readiness... '
ATTEMPT=0
while [ "$ATTEMPT" -lt "$N8N_READY_WAIT_SECONDS" ]; do
  if docker compose exec -T n8n node -e \
    "fetch('http://127.0.0.1:5678/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    echo OK
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

echo "n8n did not become ready after ${N8N_READY_WAIT_SECONDS}s"
docker compose logs --tail=100 n8n || true
exit 1
