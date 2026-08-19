# Mini-feature 01 — Foundation + Event

Primeiro slice do Event Command Center.

## Escopo

- organização multi-tenant;
- entidade `events`;
- PostgreSQL como source of truth;
- Kysely + migrations;
- transactional outbox;
- API/worker separados;
- Docker Compose e health checks.

## Regra arquitetural

Toda transição relevante grava estado e Domain Event no mesmo boundary transacional. O worker consome o outbox com semântica at-least-once; consumidores precisam ser idempotentes.

Essa base é reutilizada por todas as features seguintes.
