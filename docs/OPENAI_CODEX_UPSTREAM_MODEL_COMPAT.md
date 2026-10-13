# OpenAI Codex Upstream Model Compatibility

1. Status

- Branch: `feature/openai-codex-upstream-models`, created from fork `main` `2d6350c546` (`2026.5.10-beta.1`).
- Reference: `openclaw/openclaw` `main` `2b041e1613` (`2026.10.2`). The latest stable tag is `v2026.10.3`.
- Status: implemented and tested locally, including the generated `models.json` and the `models list` output. It is **not merged and not deployed**, and it has not been run against a live ChatGPT account.
- The first VM test showed no new models. Section 6 explains the root cause; it is fixed on this branch. The merge decision follows a repeat of the VM test in section 9.

2. Fork compared with upstream

The fork and upstream share merge-base `c906f117e6` (2026-05-11). Upstream has about 63.9k commits since then.

| Area | Fork (`2026.5.10-beta.1`) | Upstream (`2026.10.x`) |
| --- | --- | --- |
| Provider id | `openai-codex` | `openai`, unified. `openai-codex` was renamed. |
| Transport API | `openai-codex-responses` (pi-ai 0.73.1) | `openai-chatgpt-responses` |
| OAuth credential storage | `auth-profiles.json` (JSON) | SQLite. `openclaw doctor --fix` migrates it, one way only. |
| Model list | Static: pi-ai built-ins, plus manifest rows, plus synthetic Pro rows | Live, account-scoped `GET /backend-api/codex/models` through `provider-catalog-live-runtime` |
| GPT-5.6 / GPT-6 | Unknown ids | Discovered when the account lists them |
| Reasoning efforts | `off` … `xhigh` | Adds `max` |
| Node | `>=22.16` | `>=24.16` |
| Upgrade path | n/a | Older installs need the `2026.9.5` bridge release before moving to `2026.10.x` |

The VM shows GPT-5.4, 5.4 Mini, 5.5 and the Pro variants because that list is static, not because of the account's entitlements.

3. Strategy: targeted port, with the full rebase deferred

**Recommendation: port upstream's account-scoped discovery onto the current fork base now.** Plan the move to `v2026.10.3` as a separate project.

| Option | What it costs | Why |
| --- | --- | --- |
| **Targeted port (chosen)** | 1 new module and small edits inside `extensions/openai`, plus a small generic core seam (section 4) | Uses upstream's own endpoint, row filter, metadata and context limits. Keeps the provider id, transport, JSON OAuth profiles and Node 22. No credential migration. |
| Cherry-pick upstream commits | Not viable | The discovery commits (`c52583a0227`, `eb7209375ac`, `858993c1a41`, `57e0bdaabe0`) depend on the unified `openai` provider, the SQLite auth store and the `provider-catalog-live-runtime` SDK, none of which exist in the fork. |
| Rebase onto `v2026.10.3` | Large | About 33 merge conflicts, including every memory and Discord seam. Requires the Node 24 upgrade, the `2026.9.5` bridge, and the one-way SQLite auth migration (`doctor --fix`). It also renames `openai-codex/*` model refs to `openai/*` in config and sessions. |

The rebase is the right long-term move but deserves its own review: memory seam conflict resolution, a credential backup and migration rehearsal, and Node 24 on the VM.

4. What changed

**OpenAI plugin** (`extensions/openai`, public `openclaw/plugin-sdk/*` imports only):

- `openai-codex-model-discovery.ts` (new) ports upstream's discovery and adapts it to the fork:
  - **Request.** `GET https://chatgpt.com/backend-api/codex/models?client_version=0.160.0`. Headers are `Authorization: Bearer <access>` and `ChatGPT-Account-ID`, the same headers upstream uses.
  - **Account id.** Taken from the stored profile when present. Otherwise it comes from the access token's `chatgpt_account_id` claim, which is the value pi-ai's `openai-codex-responses` transport already sends on model calls.
  - **Row filter.** Keeps rows with visibility `list` or empty and `show_in_picker !== false`. Skips the platform-only `gpt-5.6` and `chat-latest` aliases.
  - **Model metadata.** Upstream's fallback metadata for `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-6.1-sol`, and `gpt-5.6-sol` / `-terra` / `-luna`, covering cost, context and reasoning efforts. This metadata only enriches rows the account returns; it is never advertised on its own. Unknown discovered ids get zero cost, as upstream does.
  - **Context limits.** gpt-5.6 rows get upstream's Codex window: 372k native and 272k runtime.
  - **Model rows.** Built on the fork's `openai-codex-responses` transport and Codex base URL.
  - **Token.** Obtained through `resolveApiKeyForProvider`, the same resolver the runtime uses, so profile order and refresh behave as normal.
  - **Cache.** Results are cached for 60 s, keyed by a SHA-256 of the endpoint, token and account. The raw token is never a key. Failures are not cached.
  - **Timeout.** 8 s.
  - **Outcomes.** Each outcome is structured, and each fresh outcome logs one line (section 7).
- `openai-codex-provider.ts`:
  - `catalog.run` writes the discovered rows into the `openai-codex` entry in `models.json`.
    - When the account is rejected (401/403), it writes an empty entry.
    - When discovery is unavailable, it writes no entry, so the merge keeps the last rows written.
  - `augmentModelCatalog` only synthesizes the 5.4 / 5.4 Mini / 5.4 Pro / 5.5 Pro rows that the account lists. It returns none when the account is rejected.
  - `normalizeResolvedModel` maps the advertised efforts onto pi-ai's `thinkingLevelMap`.
  - `gpt-6*` and `gpt-5.6*` count as modern Codex ids. `resolveDynamicModel` is unchanged, so an id the account does not list stays unknown.
- `thinking-policy.ts`: `gpt-6*` and `gpt-5.6*` get `xhigh`.

**Core** (generic, plugin-agnostic):

- `src/plugins/provider-discovery.runtime.ts` and `src/plugins/provider-discovery.ts` add an optional `credentialedProviderIds` hint.
  - Unscoped discovery already fully loads plugins without a discovery entry when they have env credentials.
  - With the hint, it also loads such plugins when one of their manifest providers has a stored auth profile.
- `src/agents/models-config.providers.implicit.ts` passes that hint for unscoped generation.
  - The ids come from the persisted `auth-profiles.json` only, with no external CLI reads and no keychain prompt.
- `src/commands/models/list.list-command.ts`, `src/cli/models-cli.ts` and `src/cli/program/route-args.ts` add `models list --refresh`.
  - The flag regenerates `models.json` before listing, scoped to `--provider` when given.

Not changed:
- ChatGPT OAuth login and device pairing, `refreshOAuth`, and the auth profile format.
- The memory extensions, Discord wiring, and gateway startup.
- The separate `codex` app-server provider (`extensions/codex`).

5. Availability semantics

- **New models appear only through discovery.** GPT-5.6 / GPT-6 rows appear only when the signed-in account's `/codex/models` response lists them.
- **Pro rows.** The synthetic Pro rows (`gpt-5.5-pro`, `gpt-5.4-pro`) are hidden unless discovery lists them.
- **Rejected token (401/403).** Discovered rows are removed, and the provider keeps only the pi-ai built-ins.
- **Discovery unavailable** (network, TLS, timeout, 429, 5xx, invalid response). The last discovered rows in `models.json` are kept. On a first run with no earlier rows, only the built-ins show. The log line says the result is not live discovery (section 7).
- **Residual gap.** pi-ai's built-in `gpt-5.4`, `gpt-5.4-mini` and `gpt-5.5` rows come from the core pi registry. They stay listed even if the account omits them. Hiding them needs a core catalog-filter seam, which is proposed for review.
- **No `max` effort.** pi-ai 0.73.1 has no `max` reasoning level. Discovered `max` efforts are kept in `compat.supportedReasoningEfforts` but not offered as a thinking level. `xhigh` is the highest selectable level.

6. Root cause of the first VM result (no new models)

Discovery code ran in tests, but on the VM it never ran at all. Four separate gaps caused this:

1. **Unscoped generation never loaded the `openai` plugin.**
   - Normal `models.json` generation is unscoped. It is used by the agent runtime fallback, the model catalog and image tools.
   - To stay bounded, unscoped generation loads plugins that ship a lightweight discovery entry. It also fully loads plugins without an entry, but only when they have env credentials.
   - The `openai` plugin owns `openai-codex` and has no discovery entry. A ChatGPT sign-in is an OAuth profile, not an env var. So the plugin was never loaded and its `catalog.run` never ran.
   - Tests passed because they called the catalog hook directly or scoped generation to `openai-codex`.
   - **Fix:** stored auth profiles now count as credentials for this selection (section 4, core).
2. **Nothing regenerated `models.json` on demand.**
   - `models list` only reads `models.json`.
   - Gateway startup prewarm uses discovery entries only, so it never runs the `openai-codex` catalog either.
   - Restarting the gateway did not refresh the list, contrary to the earlier version of section 9.
   - **Fix:** `models list --refresh`.
3. **Missing account header.**
   - Profiles created before account ids were stored have no `accountId`, so discovery sent no `ChatGPT-Account-ID` header.
   - **Fix:** use the access-token claim as a fallback, as model calls already do.
4. **Silent failures.** Every failure collapsed into one unlabeled "unavailable" state, and a failure could overwrite earlier rows with an empty list.
   - **Fix:** structured outcomes with one safe log line each, and failures keep earlier rows.

7. Discovery diagnostics

Each fresh discovery outcome logs one line under the `openai-codex/model-discovery` subsystem. Cache hits do not log. Lines never contain the token, refresh token, Authorization header, account id value or profile id. `accountId=` reports only where the header came from: `profile`, `token` or `missing`.

| Log line (after `openai-codex model discovery:`) | Level | Meaning | Action |
| --- | --- | --- | --- |
| no line | n/a | Discovery was not invoked. | Use `--refresh` (section 9, step 4). Check that an `openai-codex` profile exists. |
| `skipped (reason=no_profiles)` | debug | No `openai-codex` auth profile exists. | Sign in with `models auth login --provider openai-codex`. |
| `ready, N account models (rows=R, accountId=…)` | info | Live discovery succeeded. N rows were written. | None. |
| `ready with 0 eligible models (rows=R, …)` | warn | The account returned rows, but none are picker-visible. | Account entitlement; nothing to fix locally. |
| `auth-rejected (http=401\|403, accountId=…)` | warn | ChatGPT rejected the token or the account. | Re-run `models auth login --provider openai-codex`. If `accountId=missing`, the token has no account claim. |
| `unavailable (reason=token_resolution_failed)` | warn | The OAuth refresh or token lookup threw. | Run `models status --probe --probe-provider openai-codex`, then sign in again if needed. |
| `unavailable (reason=token_unavailable)` | warn | The profile has no usable OAuth or token credential. | Sign in again. |
| `unavailable (reason=http_rate_limited, http=429)` | warn | Rate limited. | Retry later. |
| `unavailable (reason=http_server_error, http=5xx)` | warn | ChatGPT backend error. | Retry later. |
| `unavailable (reason=http_error, http=…)` | warn | Another HTTP status. | Report the status. |
| `unavailable (reason=timeout[, code=…])` | warn | No response within 8 s. | Check connectivity or the proxy. |
| `unavailable (reason=tls, code=…)` | warn | TLS or certificate failure, for example a proxy CA. | Fix the CA or proxy setup. |
| `unavailable (reason=network, code=…)` | warn | DNS, connection or proxy failure. | Check the network and proxy. |
| `unavailable (reason=invalid_response)` | warn | The body is not JSON or is not `{ models: [] }`. | Report it; the backend shape may have changed. |

Every `unavailable` line ends with "not live discovery, previously written and built-in models are kept". Warnings reach stderr at the default log level. Set `OPENCLAW_LOG_LEVEL=debug` to also see `skipped`.

8. Test results (local, macOS, Node 22)

| Suite | Result |
| --- | --- |
| `test/vitest/vitest.extension-provider-openai.config.ts` | 23 files, 294/294 passed |
| `src/plugins` provider discovery (runtime selection, synthetic auth, catalog) | 3 files, 23/23 passed |
| `src/agents/models-config*.test.ts` (agents config), including the new `models.json` integration test | 17 of 19 files passed, 95 of 104 tests. 9 failures in 2 files predate this branch (below). |
| `src/agents/models-config.openai-codex-discovery.test.ts` (new) | 7/7 passed |
| CLI: `route-args`, `routes`, `models-cli` | 2 files, 46/46 passed |
| Commands: `src/commands/models/list*.test.ts` | 12 files, 101/101 passed |
| `test/vitest/vitest.contracts-plugin.config.ts` | 59 files, 781/781 passed |
| Memory seams: ACP manager and translator, embedded runner attempt, auto-reply runner | 10 files, 131/131 passed |
| `src/memory/*.test.ts`, including the Discord turn episode adapter | 6 files, 183/183 passed |
| Discord `message-handler*` tests | 10 files, 133/133 passed |
| Codex app-server candidate queue | 1 file, 12/12 passed |
| `tsc --noEmit` | exit 0 (`tsgo` is killed for memory in this environment; CI runs `tsgo`) |
| `oxfmt` / `oxlint` on changed files | clean |

`src/agents/models-config.openai-codex-discovery.test.ts` uses real plugin loading, real auth-profile resolution, real `models.json` planning and the real `models list` command. Only `fetch` is simulated, with a simulated OAuth profile that has no `accountId`. It proves:
- unscoped generation (the normal runtime path) writes GPT-6 Luna, GPT-6 Sol, GPT-5.6 Terra and GPT-5.4 to `models.json`, and drops hidden and non-picker rows;
- the request URL carries `client_version=0.160.0`, and `ChatGPT-Account-ID` comes from the token claim;
- scoped generation writes the same rows;
- a 503 keeps earlier rows, a first-run network failure writes none, and a 401 clears them;
- no profile means no request;
- `models list --provider openai-codex --refresh` and `models list --all --provider openai-codex` show the discovered rows.

Before the core fix, the same unscoped scenario made zero discovery requests.

**Earlier failures in other tests.** `models-config.skips-writing-models-json-no-env-token.test.ts` (4 tests) and `models-config.uses-first-github-copilot-profile-env-tokens.test.ts` (5 tests) also fail at `ceabe7b8ea6`, the commit before this fix.
- **Cause.** Each test replaces `./models-config.providers.js` with a `vi.mock` that lacks `normalizeProviderCatalogModelsForConfig`, which `models-config.plan.ts` imports.
- **Scope.** This branch does not change those files, and fixing them is out of scope.

The normal `pnpm test` runner fails in this sandbox: its automatic `pnpm install` cannot run the esbuild postinstall. The suites were run with the repo's Vitest configs directly (`node node_modules/vitest/vitest.mjs run --config <config> --maxWorkers=1 <files>`). The repo oxlint wrapper also fails here while preparing boundary artifacts, so `node_modules/.bin/oxlint` was run directly.

**Not verified locally:**
- live discovery against the account;
- whether the backend accepts `gpt-5.6*` / `gpt-6*` on pi's `openai-codex-responses` transport;
- whether `client_version=0.160.0` gates any rows. That value matches the `@openai/codex` version upstream bundles;
- a real model call.

Upstream behavior to watch for on the VM:
- Upstream notes that `gpt-6-astra` can be refused for ChatGPT-account Codex use on some paths, and falls back to `gpt-6-luna`. If Astra is listed but fails in step 6, prefer `gpt-6-sol` or `gpt-6-luna`.
- Upstream hides `gpt-5.4` on ChatGPT hosts in favor of `gpt-5.6-terra`. This branch leaves `gpt-5.4` alone, because it passed the live probe.

9. VM validation instructions

Run these on the VM from the fork checkout, as the user that runs OpenClaw. The VM runs the gateway from source with `pnpm gateway:watch`, and every CLI call goes through `pnpm openclaw`. Do not print or copy credential files.

1. Back up the state directory. It contains the credentials; keep the archive private.
   ```bash
   tar -czf ~/openclaw-state-backup-$(date +%Y%m%d).tgz -C ~ .openclaw
   ```
2. Update the branch. It adds no dependencies.
   ```bash
   git fetch origin
   git checkout feature/openai-codex-upstream-models
   git pull --ff-only
   pnpm install --frozen-lockfile
   ```
3. Restart the gateway so it runs the new code.
   ```bash
   pnpm gateway:watch
   ```
   A restart alone does not regenerate the model list (section 6, item 2).
4. Run live discovery and list the result. Check the stderr line against section 7.
   ```bash
   pnpm openclaw models list --provider openai-codex --refresh
   pnpm openclaw models list --provider openai-codex --json
   pnpm openclaw models list --all --provider openai-codex
   ```
   - The first command must print one `openai-codex model discovery:` line.
   - On `ready`, the GPT-6 / GPT-5.6 ids the account lists appear in all three.
   - For more detail: `OPENCLAW_LOG_LEVEL=debug pnpm openclaw models list --provider openai-codex --refresh`.
5. Check that auth still works:
   ```bash
   pnpm openclaw models status --probe --probe-provider openai-codex
   ```
6. Invoke each newly listed model. The ids below are examples; use the ones step 4 lists.
   ```bash
   pnpm openclaw agent --local --model openai-codex/gpt-6-sol --message "Reply OK"
   pnpm openclaw agent --local --model openai-codex/gpt-6-luna --message "Reply OK"
   pnpm openclaw agent --local --model openai-codex/gpt-5.4 --message "Reply OK"
   ```
   - If config sets `agents.defaults.models` (a model allowlist), add the new refs there first, or `--model` rejects them.
7. Change the default model only when step 6 succeeds.
   - Example: set `agents.defaults.model.primary` to `openai-codex/gpt-6-sol`, then run `pnpm gateway:watch` again to restart.
   - If that model is not discovered, leave the current default as it is.
8. Verify the memory and Discord paths with one Discord turn: the reply is delivered and the memory adapter logs a capture.

**If the model list does not change:** use the step 4 log line and section 7.
- No line at all means discovery did not run. Report it with the command output.
- A listed model that fails at invocation means the backend rejected it on pi's transport. Remove it from config and report the error.

**Rollback:**
1. Run `git checkout main`. Fork `main` is `2d6350c546`.
2. Run `pnpm gateway:watch` to restart.
3. Restore any changed `agents.defaults.model.primary`.
4. Optionally run `pnpm openclaw models list --refresh` to rewrite `models.json` without discovered rows.

No credential rollback is needed, because the branch does not change auth storage.

10. Open questions for review

- Should a core catalog-filter seam hide pi-ai built-in Codex rows that the account does not list?
- Should gateway startup run scoped live discovery for the configured primary provider? Today it stays entries-only, to keep readiness fast.
- When should the rebase onto `v2026.10.3` be scheduled? It brings the Node 24 upgrade, the `2026.9.5` bridge, the SQLite auth migration and the `openai/*` model ref rename.
