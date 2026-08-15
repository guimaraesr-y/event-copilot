# Feature 08.1 — Provider-agnostic AI + Ollama

Apply this patch over Mini-feature 08.

Highlights:
- AICommandInterpreter no longer knows any vendor API.
- OllamaCommandProvider uses `/api/chat` + JSON-schema structured outputs.
- OpenAICommandProvider preserves Responses API support.
- `AI_PROVIDER=ollama|openai` selects the provider.
- Ollama runs through Compose profile `ai` with persistent model volume.
- `./scripts/ollama-setup.sh` starts Ollama and pulls the configured model.
- `./scripts/ollama-command-check.sh` runs five live quality/latency scenarios.
- normal `./scripts/smoke-env.sh` remains deterministic and rule-based; it does not start Ollama.

Suggested local configuration:

```env
COMMAND_INTERPRETER=ai
AI_PROVIDER=ollama
OLLAMA_COMMAND_MODEL=qwen3:4b
OLLAMA_BASE_URL=http://ollama:11434
```

Then:

```sh
./scripts/ollama-command-check.sh
docker compose --profile ai up -d ollama
docker compose up -d --build api
```
