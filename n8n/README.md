# n8n workflows

Mini-feature 04 introduces the first production workflow:

- `workflows/ecc-domain-event-gateway.json`

Install/update it in the running n8n instance with:

```bash
./scripts/n8n-sync.sh
```

The sync script imports the workflow and publishes `eccDomainEventGw1`. No n8n credential contains the ECC HMAC secret: the worker signs every domain-event envelope, and the backend verifies that signature when n8n calls the internal API.

The production webhook is internal-only and is not routed publicly by Caddy.
