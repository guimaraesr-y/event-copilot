# ECC Smoke Environment Patch

This patch isolates the complete smoke test (features 01 through 06) from the normal developer environment.

## Apply

Copy these files over the project root, preserving paths.

## Run

```sh
./scripts/smoke-env.sh
```

By default it:
1. loads and exports `.env.smoke`;
2. refuses to run unless `COMPOSE_PROJECT_NAME` contains `smoke`;
3. refuses to run unless `WHATSAPP_PROVIDER=mock`;
4. resets only the dedicated smoke project's volumes;
5. starts the stack;
6. waits for readiness;
7. runs the existing full `scripts/smoke.sh`.

To keep the previous smoke volumes:

```sh
SMOKE_RESET=0 ./scripts/smoke-env.sh
```

Your normal `.env` and Meta credentials are not used.
