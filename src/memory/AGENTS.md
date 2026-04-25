# Memory Context Adapter Guide

This subtree owns the bridge between OpenClaw and `openclaw-memory-core`.
Treat it as a thin, fail-open seam, not a memory implementation.

## Boundary

- Do not import `openclaw-memory-core` source, packages, or installed Python
  modules from TypeScript here. The only allowed coupling is the public CLI
  contract: `python -m openclaw_memory_core.integration.memory_context_cli
  --query "<prompt>"`.
- Do not reach for Postgres, pgvector, EmbeddingGemma, `openclaw-embedding-core`,
  `RuntimeContextService`, `ContextRequest`, or `PostgresEpisodicRetrieval`. If
  you need new memory behavior, add it to `openclaw-memory-core` and expose it
  through the CLI / its env contract.
- Do not hardcode DSNs, passwords, model paths, model identities, embedding
  engines, devices, or tokens. The full `process.env` is forwarded to the
  subprocess so memory-core can read its own env vars (`OPENCLAW_MEMORY_*`,
  `OPENCLAW_EMBEDDING_*`, `EMBEDDING_*`, etc.).

## Configuration

The adapter reads only these vars from `openclaw-custom`:

| Env var                       | Default  | Purpose                                          |
| ----------------------------- | -------- | ------------------------------------------------ |
| `OPENCLAW_MEMORY_ENABLED`     | `false`  | Master switch. Disabled = adapter is a no-op.    |
| `OPENCLAW_MEMORY_PYTHON`      | `python` | Interpreter used to launch the memory CLI.       |
| `OPENCLAW_MEMORY_TIMEOUT_MS`  | `3000`   | Subprocess timeout (ms).                         |
| `OPENCLAW_MEMORY_MAX_CHARS`   | `4000`   | Defensive cap on returned context length.        |
| `OPENCLAW_MEMORY_STRICT`      | `false`  | If `true`, surface CLI failures as thrown errors.|

All other knobs (DSN, embedding engine, device, etc.) belong to memory-core.

## Behavior

- Disabled or empty/whitespace query => return `""` and skip subprocess.
- Strict mode is opt-in. Default is fail-open: log and return `""` on spawn
  errors, ENOENT, timeouts, signal kills, non-zero exits, or oversize stdout.
- The full incoming `process.env` is passed through to the subprocess so the
  CLI can resolve its own configuration. Do not curate or filter env vars in
  this layer.
- The adapter does not assemble prompt markup. The caller (currently
  `src/acp/translator.ts`) is responsible for wrapping the returned block in a
  bounded `<memory_context>` / `<user_request>` envelope and respecting
  `MAX_PROMPT_BYTES`.

## Tests

- Drive the adapter with the injected `spawnSync` / `env` / `log` deps. Do not
  spawn real Python in unit tests.
- Cover the full failure surface (disabled, empty query, ENOENT, timeout,
  non-zero exit, oversize stdout, strict-mode throws). The adapter is the only
  unit-test seam for these branches; translator/integration tests should not
  duplicate them.
