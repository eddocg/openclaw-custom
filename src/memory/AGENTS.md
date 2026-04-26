# Memory Context Adapter Guide

This subtree owns the bridge between OpenClaw and `openclaw-memory-core`.
Treat it as a thin, fail-open seam, not a memory implementation.

It contains two collaborating pieces:

- `memory-context-adapter.ts` - subprocess adapter that calls the
  `openclaw-memory-core` CLI and returns a raw memory string (no markup).
- `memory-context-injection.ts` - shared injector that wraps the prompt with
  the `<memory_context>` / `<user_request>` envelope, with idempotence so a
  pre-wrapped prompt is never wrapped twice.

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
- The adapter does not assemble prompt markup. Wrapping is the injector's job.

## Injection envelope

`memory-context-injection.ts` exposes:

- `isPromptAlreadyWrapped(prompt)`: returns `true` when an `<memory_context>`
  open tag is followed by a matching close tag inside the first 32 KiB of the
  prompt. Used for idempotence so existing wraps (already-wrapped retries,
  manually authored test prompts, etc.) pass through untouched.
- `wrapPromptWithMemoryContext(promptToWrap, memoryBlock)`: emits the exact
  envelope verbatim:

  ```
  <memory_context>
  {memoryBlock}
  </memory_context>

  <user_request>
  {promptToWrap}
  </user_request>
  ```

- `createMemoryContextInjector({ adapter?, log? })`: returns
  `{ inject({ promptToWrap, query }) }`. The injector resolves the memory
  block by calling the adapter with `query` and wraps `promptToWrap` only
  when:
    1. `query` is non-empty after trim,
    2. `promptToWrap` is not already wrapped,
    3. the adapter returns a non-empty block.
  Otherwise the injector returns `promptToWrap` unchanged. `MemoryContextError`
  bubbles out of `inject` so callers can honor strict-mode behavior.

`promptToWrap` and `query` are intentionally separate arguments so callers
can submit a fully composed prompt (e.g. the embedded runner's
`effectivePrompt` after bootstrap/plugin/orphan layering) while still
querying memory with the raw user text.

## Wiring (single wrap, two seams)

The adapter / injector is consumed at two seams. There is exactly one wrap per
turn even when both seams are reachable, because the second seam observes the
already-wrapped prompt and no-ops.

- Embedded runner: `src/agents/pi-embedded-runner/run/attempt.ts` calls
  `memoryInjector.inject({ promptToWrap: effectivePrompt, query: params.prompt })`
  immediately before `activeSession.prompt(...)`. The wrap is applied to the
  final effectivePrompt so the model sees the layered prompt inside
  `<user_request>`. The retrieval query stays on the raw user prompt so
  bootstrap/plugin/orphan-merge text does not leak into memory queries.
- ACP runtime: `src/acp/control-plane/manager.core.ts` (inside
  `AcpSessionManager.runTurn`) calls
  `memoryInjector.inject({ promptToWrap: input.text, query: input.text })`
  before the retry loop and forwards the wrapped text as `runtime.runTurn({
  text: effectiveText, ... })`. The background-task summary keeps the raw
  `input.text` so operator-visible task titles never leak retrieved memory.

`AcpSessionManager` accepts the injector via `AcpSessionManagerDeps`; the
default ships in `manager.types.ts` (`createMemoryContextInjector()`) and is
overridable in tests.

The ACP translator (`src/acp/translator.ts`) does not own any memory wrap.
It forwards the user's raw text plus the optional working-directory prefix
to `chat.send`, and downstream paths (embedded runner or ACP runtime) apply
the envelope. Do not reintroduce a translator-local wrap; that would cause
double injection in the gateway path.

### Known gap: CLI provider path

Self-hosted CLI providers that bypass both the embedded runner and the ACP
runtime currently do not run the injector. Adding memory injection to that
path is in scope for a follow-up that introduces a shared seam those
providers can opt into; until then, memory is silently disabled there.

## Guards / Regression tests

- `extensions/discord/src/monitor/message-handler.process.no-memory-prototype.test.ts`
  blocks the old Discord-specific memory prototype from coming back. Memory
  context is now resolved via the shared injector, never via channel-local
  Python invocations or direct memory-core internals.
- `src/agents/pi-embedded-runner/run/attempt.memory-injection.test.ts` is a
  source-level wiring guard that proves the embedded runner calls
  `memoryInjector.inject({ promptToWrap: effectivePrompt, query: params.prompt })`
  immediately before `activeSession.prompt(...)`, and that no early wrap of
  `params.prompt` is reintroduced before bootstrap/plugin/orphan layering.
- `src/acp/control-plane/manager.memory-injection.test.ts` covers the
  `AcpSessionManager.runTurn` seam: wrapped output forwarded to
  `runtime.runTurn`, idempotent pass-through of pre-wrapped input, no-op when
  the adapter returns an empty block, and `MemoryContextError` propagation.
- `src/acp/translator.memory-injection.test.ts` is now a regression test: it
  asserts the translator forwards the raw text (with optional cwd prefix) and
  never emits `<memory_context>` / `<user_request>` tags itself.

## Tests

- Drive the adapter with the injected `spawnSync` / `env` / `log` deps. Do not
  spawn real Python in unit tests.
- Cover the full failure surface (disabled, empty query, ENOENT, timeout,
  non-zero exit, oversize stdout, strict-mode throws). The adapter is the only
  unit-test seam for these branches; injector / wiring tests should not
  duplicate them.
- Drive the injector with an injected `MemoryContextAdapter`. Tests should
  exercise: empty query short-circuit, idempotent already-wrapped input,
  empty-block pass-through, full wrap, raw query forwarding, and
  `MemoryContextError` propagation. These are owned by
  `memory-context-injection.test.ts`; downstream wiring tests should assert
  only that the injector is reached at the right seam.
