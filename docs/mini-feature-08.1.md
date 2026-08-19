# Mini-feature 08.1 — AI Provider Abstraction + Ollama

Camada provider-agnostic criada originalmente para o Command Engine e posteriormente reutilizada pelo Operational Agent.

## Objetivos

- permitir IA local via Ollama;
- manter OpenAI/futuros providers desacoplados;
- validar toda saída antes de chegar ao domínio;
- manter smoke determinístico;
- permitir comparação de modelos sem mudar regras de negócio.

## Ollama

O Compose oferece o profile `ai` e persiste modelos em volume próprio.

```bash
docker compose --profile ai up -d ollama
./scripts/ollama-setup.sh
```

O benchmark manual do antigo Command Interpreter está em [ollama-command-benchmark.md](ollama-command-benchmark.md).

Com a evolução para a Feature 08.2, o Operational Agent passou a ser a interface inteligente principal; o Command Interpreter permanece útil para caminhos estruturados/fallback.
