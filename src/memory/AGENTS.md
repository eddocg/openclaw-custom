# Memory Context Adapter Guide

This subtree owns the bridge between OpenClaw and `openclaw-memory-core`.
Treat it as a thin, fail-open seam, not a memory implementation.

It contains three collaborating pieces:

- `memory-context-adapter.ts` - subprocess adapter that calls the
  `openclaw-memory-core` retrieval CLI and returns a raw memory string (no
  markup).
- `memory-context-injection.ts` - shared injector that wraps the prompt with
  the `<memory_context>` / `<user_request>` envelope, with idempotence so a
  pre-wrapped prompt is never wrapped twice.
- `memory-ingest-adapter.ts` - subprocess adapter for the **write path**.
  Detects "remember this / save this" triggers in raw inbound user text and
  forwards the content to the `openclaw-memory-core` ingest CLI under a
  hybrid grace+detach contract.

## Boundary

- Do not import `openclaw-memory-core` source, packages, or installed Python
  modules from TypeScript here. The only allowed coupling is the public CLI
  contract: `python -m openclaw_memory_core.integration.memory_context_cli
  --query "<prompt>"` (read) and `python -m
  openclaw_memory_core.integration.memory_ingest_cli --source-type memory
  --content "<text>"` (write).
- Do not reach for Postgres, pgvector, EmbeddingGemma, `openclaw-embedding-core`,
  `RuntimeContextService`, `ContextRequest`, or `PostgresEpisodicRetrieval`. If
  you need new memory behavior, add it to `openclaw-memory-core` and expose it
  through the CLI / its env contract.
- Do not hardcode DSNs, passwords, model paths, model identities, embedding
  engines, devices, or tokens. The full `process.env` is forwarded to the
  subprocess so memory-core can read its own env vars (`OPENCLAW_MEMORY_*`,
  `OPENCLAW_EMBEDDING_*`, `EMBEDDING_*`, etc.).

## Configuration

Retrieval (`memory-context-adapter.ts`) reads:

| Env var                       | Default  | Purpose                                          |
| ----------------------------- | -------- | ------------------------------------------------ |
| `OPENCLAW_MEMORY_ENABLED`     | `false`  | Master switch. Disabled = adapter is a no-op.    |
| `OPENCLAW_MEMORY_PYTHON`      | `python` | Interpreter used to launch the memory CLI.       |
| `OPENCLAW_MEMORY_TIMEOUT_MS`  | `3000`   | Retrieval subprocess timeout (ms).               |
| `OPENCLAW_MEMORY_MAX_CHARS`   | `4000`   | Defensive cap on returned context length.        |
| `OPENCLAW_MEMORY_STRICT`      | `false`  | If `true`, surface CLI failures as thrown errors.|

Ingest (`memory-ingest-adapter.ts`) reads:

| Env var                              | Default   | Purpose                                                    |
| ------------------------------------ | --------- | ---------------------------------------------------------- |
| `OPENCLAW_MEMORY_ENABLED`            | `false`   | Shared master switch. Disabled = adapter is a no-op.       |
| `OPENCLAW_MEMORY_PYTHON`             | `python3` | Interpreter used to launch the ingest CLI.                 |
| `OPENCLAW_MEMORY_INGEST_TIMEOUT_MS`  | `30000`   | Hard subprocess timeout (ms). Larger than retrieval because the ingest CLI loads the embedding model and writes the row. |
| `OPENCLAW_MEMORY_INGEST_GRACE_MS`    | `500`     | Awaited window before the call site detaches and continues without blocking the turn. Clamped to `<= timeout`. |
| `OPENCLAW_MEMORY_STRICT`             | `false`   | Shared. If `true`, surface CLI failures as thrown errors during the grace window. |
| `OPENCLAW_MEMORY_DEBUG`              | `false`   | Shared. If `true`, the ingest adapter and both ingest seams emit `[memory-ingest]` breadcrumbs through the injected `log` callback (or `log.debug` / `logVerbose` at the seams). Read once per call from `process.env`; restart the gateway after toggling. |

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

## Write path (semantic-memory ingest)

The write path is intentionally a side-effect-only adapter. It never
modifies prompt text, never blocks the turn beyond `OPENCLAW_MEMORY_INGEST_GRACE_MS`,
and is wired at the same two terminal seams as the retrieval injector so it
covers the local CLI, the gateway `agent` RPC, channel extensions, and the
ACP gateway translator without per-channel duplication.

### Trigger detection

Conservative, longest-prefix-first, case-insensitive, leading whitespace
tolerated:

1. `remember this as semantic memory`
2. `save this as semantic memory`
3. `remember this`
4. `save this`

Any other prefix returns `skipped:no_trigger` and the adapter does not
spawn.

### Content extraction

If the matched trigger is followed by a `:` or `::` (with optional
whitespace), the content sent to the CLI is the remainder after the colon,
trimmed. Otherwise the content is the original raw text, trimmed. The
content is hard-capped at 16 KB before being passed as `--content` to bound
the subprocess argv.

### Double-ingest guard

If the inbound text contains `<memory_context>` or `<user_request>` anywhere
the adapter returns `skipped:wrapped` without spawning. This protects against
re-ingesting wrapped prompts that the retrieval injector or upstream retries
might surface.

### Hybrid grace+detach

`ingest()` returns as soon as the child finishes within
`OPENCLAW_MEMORY_INGEST_GRACE_MS`. If the grace expires first the call
resolves with `status: "detached"` and the child continues running in the
background up to `OPENCLAW_MEMORY_INGEST_TIMEOUT_MS`, after which it is
SIGTERM'd. This bounds the awaited delay on the matching turn while still
giving the CLI enough time to load the embedding model and write the row.

**Strict-mode caveat:** `OPENCLAW_MEMORY_STRICT=true` only converts
in-grace failures into `MemoryIngestError`. Failures observed after the
grace window cannot abort an already-detached call site and are logged
instead. If you need fully strict behavior set
`OPENCLAW_MEMORY_INGEST_GRACE_MS` to match the timeout (the adapter clamps
larger values down).

### Wiring

The ingest adapter is consumed at the same two seams as the retrieval
injector. Each seam takes the raw user text:

- Embedded runner: `src/agents/pi-embedded-runner/run/attempt.ts` calls
  `await memoryIngester.ingest(params.prompt)` near run start, before the
  late-bound `memoryInjector.inject(...)` call. The ingest adapter only
  reacts to a small set of trigger phrases, so the no-trigger fast path
  exits before any subprocess work.
- ACP runtime: `src/acp/control-plane/manager.core.ts` (inside
  `AcpSessionManager.runTurn`) calls
  `await this.deps.memoryIngester.ingest(input.text)` immediately before
  `memoryInjector.inject(...)`. The raw `input.text` is preserved for the
  background-task summary, the runtime call, and the ingest call.

`AcpSessionManager` accepts the ingester via `AcpSessionManagerDeps`; the
default ships in `manager.types.ts` (`createMemoryIngestAdapter({ log: ... })`)
and is overridable in tests. The default `log` bridges adapter messages to
`logVerbose` so its `[memory-ingest]` breadcrumbs land in the same stream as
the seam markers below.

### Debug observability

When `OPENCLAW_MEMORY_DEBUG=true`:

- The ingest adapter emits `[memory-ingest]` breadcrumbs at every state
  transition (call entry, every skip status, trigger match, subprocess start,
  spawned PID, grace-expiry detach, child close with code/signal previews,
  and the final status / reason / spawned). Logs go through the injected
  `log` callback. Embedded runner uses `log.debug`; ACP runtime uses
  `logVerbose`.
- Each seam also emits two short markers for unambiguous attribution:
  - Embedded runner: `[memory-ingest] seam=embedded-attempt ingest-start` /
    `seam=embedded-attempt ingest-result status=<status> reason=<reason-or-none>`.
  - ACP runtime: `[memory-ingest] seam=acp-manager ingest-start` /
    `seam=acp-manager ingest-result status=<status> reason=<reason-or-none>`.
- All previews are passed through `previewText(...)`: whitespace is
  collapsed, the result is trimmed, and inputs are capped at 300 chars with
  a trailing ellipsis. The configured Python interpreter is logged as just
  the basename when it looks path-like, never the full absolute path. Model
  paths, env values, DSNs, tokens, and `--content` payloads are never
  logged.
- The flag is read from `process.env` per call. Toggling it without
  restarting the gateway is not supported; restart the gateway after
  changing the env var.

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
- `src/agents/pi-embedded-runner/run/attempt.memory-ingest.test.ts` is the
  source-level wiring guard for the write path: it proves the ingest adapter
  is awaited at run start with the raw `params.prompt`, before the late-bound
  inject, and never with a wrapped prompt.
- `src/acp/control-plane/manager.memory-ingest.test.ts` covers the ACP
  runtime: ingest is invoked once per turn with the raw `input.text`, runs
  before `runtime.runTurn`, never alters the forwarded prompt, and aborts the
  turn when the adapter throws `MemoryIngestError` in strict mode.

## Tests

- Drive the retrieval adapter with the injected `spawnSync` / `env` / `log`
  deps. Do not spawn real Python in unit tests.
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
- Drive the ingest adapter with an injected async `spawn` factory plus
  Vitest fake timers. Tests should exercise: trigger detection, content
  extraction with/without colons, the no-double-ingest guard, disabled / empty
  / no-trigger short-circuits, fail-open vs strict-mode failures within the
  grace window, the detach pathway when grace expires, the hard-timeout
  SIGTERM, and post-detach failures being logged instead of thrown. These are
  owned by `memory-ingest-adapter.test.ts`; wiring tests should only assert
  that the adapter is reached at the right seam with the raw text.
