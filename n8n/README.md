# n8n workflows

Mini-feature 05 ships two stable workflow exports:

- `ECC - Domain Event Gateway` (`eccDomainEventGw1`): verifies signed domain events, prepares vendor-confirmation automation actions, creates the durable outbound message, and invokes the configured provider.
- `ECC - WhatsApp Status Gateway` (`eccWhatsAppStatusGw1`): receives signed provider-neutral delivery callbacks and persists `sent/delivered/read/failed` state through the API.

Use `./scripts/n8n-sync.sh` after the n8n container is healthy. The script imports and publishes both workflows, then restarts n8n once so production webhooks are registered.

The domain-event webhook is Docker-network internal. The WhatsApp/provider status webhook is intentionally reachable through the n8n gateway for callback simulation and future provider adapters, but the API endpoint behind it is still internal and validates a timestamped HMAC.
