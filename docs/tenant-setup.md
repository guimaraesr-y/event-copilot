# Tenant Setup / Bootstrap

O `scripts/setup-tenant.ts` cria a estrutura inicial de um tenant usando exclusivamente a API pública do Event Command Center.

Ele foi desenhado para dois usos:

1. preparar rapidamente um ambiente local e testar um número real como fornecedor;
2. servir como bootstrap de onboarding/deploy de um tenant em produção.

## O que o script cria/reutiliza

- organização;
- template de evento;
- tasks e milestones padrão (opcional);
- evento inicial;
- fornecedor;
- vínculo fornecedor ↔ evento;
- opcionalmente, solicitação de confirmação do fornecedor.

O script não apaga dados e tenta reutilizar recursos existentes por nome/ID.

## Primeiro uso local

Copie o exemplo:

```bash
cp .tenant.setup.example.env .tenant.setup.env
```

Edite principalmente:

```env
BASE_URL=http://localhost:8080
TENANT_NAME=Meu Cerimonial
EVENT_NAME=Casamento Teste
EVENT_START_AT=2026-10-17T17:30:00-03:00
VENDOR_NAME=Fornecedor Teste Ryan
VENDOR_PHONE=+5521999999999
```

Execute sem enviar WhatsApp:

```bash
bun scripts/setup-tenant.ts --config .tenant.setup.env
```

Depois de conferir os IDs/dados:

```bash
bun scripts/setup-tenant.ts --config .tenant.setup.env --send-confirmation
```

`--send-confirmation` é deliberadamente opt-in para evitar envio acidental em produção.

## Estado e idempotência

A API atual não expõe listagem global de organizações, pois `x-organization-id` é a fronteira provisória de tenant. Por isso o bootstrap salva os IDs criados em um state file:

```text
.ecc/tenants/<tenant>.json
```

Exemplo:

```json
{
  "organizationId": "...",
  "templateId": "...",
  "eventId": "...",
  "vendorId": "...",
  "eventVendorId": "..."
}
```

Guarde esse arquivo no processo de deployment ou configure explicitamente:

```env
TENANT_ORGANIZATION_ID=<uuid>
```

Os demais recursos são reencontrados via endpoints de listagem por tenant.

## Produção

Exemplo:

```bash
bun scripts/setup-tenant.ts \
  --config deploy/acme.tenant.env \
  --state /var/lib/ecc/tenants/acme.json
```

Em pipelines de deployment, recomendamos executar primeiro sem `--send-confirmation` e tratar o envio real como uma ação de onboarding separada.

O script é seguro para bootstrap/reexecução, mas isso **não torna a autenticação atual production-ready**: enquanto o ECC usar apenas `x-organization-id` como contexto de tenant, uma camada real de autenticação/autorização ainda precisa ser implementada antes de exposição pública irrestrita.

## Criar um novo evento intencionalmente

Se já existe um evento com o mesmo nome/tipo e você realmente quer outro:

```bash
bun scripts/setup-tenant.ts --config .tenant.setup.env --force-new-event
```

Sem essa flag, múltiplos eventos iguais provocam erro em vez de o script escolher silenciosamente.

## Dry-run

Quando a organização já existe:

```bash
bun scripts/setup-tenant.ts --config .tenant.setup.env --dry-run
```

O dry-run não cria a primeira organização porque não teria um ID real para encadear as próximas operações.

## Saída JSON

Para CI/CD:

```bash
bun scripts/setup-tenant.ts --config .tenant.setup.env --json
```

## Fluxo para testar seu próprio número

Com `WHATSAPP_PROVIDER=meta` no ambiente da aplicação e o número de fornecedor configurado:

```bash
bun scripts/setup-tenant.ts --config .tenant.setup.env --send-confirmation
```

Isso termina em:

```text
organization
  ↓
event/template
  ↓
vendor
  ↓
event_vendor
  ↓
confirmation-request
  ↓
outbox → worker → n8n → outbound_messages → Meta
```

A resposta do fornecedor volta pelo webhook genérico e pode ser processada pela Feature 06.

## Atalho opcional no package.json

Se quiser expor um script no `package.json`, adicione manualmente:

```json
{
  "scripts": {
    "tenant:setup": "bun scripts/setup-tenant.ts"
  }
}
```

O patch não sobrescreve seu `package.json` para não apagar alterações locais.

## Versionamento

O state file contém apenas IDs, mas representa o vínculo de onboarding do tenant. Em geral, mantenha-o fora do Git e persista-o junto do estado de deployment:

```gitignore
.ecc/tenants/
.tenant.setup.env
```

O script grava o state progressivamente após cada recurso ser criado/reutilizado. Portanto, se o setup falhar no meio, a próxima execução consegue continuar sem recriar a organização já provisionada.
