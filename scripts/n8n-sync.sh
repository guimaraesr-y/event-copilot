#!/usr/bin/env sh
set -eu

N8N_READY_WAIT_SECONDS="${N8N_READY_WAIT_SECONDS:-30}"

# Git Bash/MSYS rewrites POSIX-looking arguments passed to Windows executables.
# For example, --input=/files/n8n/workflows/foo.json becomes
# C:/Program Files/Git/files/n8n/workflows/foo.json before Docker receives it.
# These paths are meant for the Linux container, so disable MSYS argument/path
# conversion for this script. The variables are ignored on Linux/macOS.
case "$(uname -s 2>/dev/null || printf unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    export MSYS_NO_PATHCONV=1
    export MSYS2_ARG_CONV_EXCL='*'
    ;;
esac

show_n8n_diagnostics() {
  echo "n8n container status:" >&2
  docker compose ps n8n >&2 || true
  echo "n8n recent logs:" >&2
  docker compose logs --tail=120 n8n >&2 || true
}

wait_for_n8n_process() {
  _n8n_phase="$1"
  printf 'Waiting for n8n process readiness (%s)... ' "$_n8n_phase"

  _n8n_attempt=0
  while [ "$_n8n_attempt" -lt "$N8N_READY_WAIT_SECONDS" ]; do
    if docker compose exec -T n8n node -e       "fetch('http://127.0.0.1:5678/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"       >/dev/null 2>&1; then
      echo OK
      return 0
    fi

    _n8n_attempt=$((_n8n_attempt + 1))
    sleep 1
  done

  echo "FAILED"
  echo "n8n did not become ready during ${_n8n_phase} after ${N8N_READY_WAIT_SECONDS}s" >&2
  show_n8n_diagnostics
  return 1
}

run_n8n_cli() {
  _cli_label="$1"
  shift

  printf '%s... ' "$_cli_label"

  # n8n CLI writes some failures to stdout rather than stderr, so capture both
  # and only hide them on success. This keeps smoke output compact while making
  # failures actionable.
  if _cli_output=$(docker compose exec -T n8n n8n "$@" 2>&1); then
    echo OK
    return 0
  else
    _cli_status=$?
    echo FAILED
    printf '%s\n' "$_cli_output" >&2
    show_n8n_diagnostics
    return "$_cli_status"
  fi
}

sync_workflow() {
  _workflow_id="$1"
  _workflow_file="$2"
  _workflow_label="$3"

  run_n8n_cli "Importing $_workflow_label" import:workflow --input="$_workflow_file"
  run_n8n_cli "Publishing $_workflow_label" publish:workflow --id="$_workflow_id"
}

# API readiness does not imply n8n readiness. On fast/cached builds the smoke
# can reach workflow import while n8n is still running its own startup work.
# Always wait for the n8n process before invoking its CLI.
wait_for_n8n_process "before workflow import"

sync_workflow "eccDomainEventGw1" "/files/n8n/workflows/ecc-domain-event-gateway.json" "ECC Domain Event Gateway"

# n8n CLI publication updates the database. Restart the runtime once after all
# imports so production webhooks are registered from the published versions.
printf 'Restarting n8n to register production webhooks... '
docker compose restart n8n >/dev/null
echo OK

wait_for_n8n_process "after workflow publish/restart"

# /healthz can become ready before published production webhooks are registered.
# Probe the production path itself. A registered workflow may reject this dummy
# envelope with 4xx/5xx; the only state we reject here is n8n's webhook 404.
printf 'Waiting for production webhook registration... '
attempt=0
while [ "$attempt" -lt "$N8N_READY_WAIT_SECONDS" ]; do
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
  attempt=$((attempt + 1))
  sleep 1
done

echo "FAILED"
echo "n8n production webhook was not registered after ${N8N_READY_WAIT_SECONDS}s" >&2
show_n8n_diagnostics
exit 1
