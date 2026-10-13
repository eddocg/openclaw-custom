# OpenAI Codex Upstream Model Compatibility

1. Status

- Branch: `feature/openai-codex-upstream-models`, created from fork `main` `2d6350c546` (`2026.5.10-beta.1`).
- Reference: `openclaw/openclaw` `main` `2b041e1613` (`2026.10.2`). The latest stable tag is `v2026.10.3`.
- Status: implemented and unit-tested. It is **not merged and not deployed**, and it has not been run against a live ChatGPT account. It is waiting for architectural review.

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

The VM currently shows GPT-5.4, 5.4 Mini, 5.5 and the Pro variants because that list is static, not because of the account's entitlements. Newer models never appear because the fork has no live discovery.

3. Strategy: targeted port, with the full rebase deferred

**Recommendation: port upstream's account-scoped discovery onto the current fork base now.** Plan the move to `v2026.10.3` as a separate project.

| Option | What it costs | Why |
| --- | --- | --- |
| **Targeted port (chosen)** | 1 new module + 3 small edits inside `extensions/openai` | Uses upstream's own endpoint, row filter, metadata and context limits. Keeps the provider id, transport, JSON OAuth profiles and Node 22. No credential migration. |
| Cherry-pick upstream commits | Not viable | The discovery commits (`c52583a0227`, `eb7209375ac`, `858993c1a41`, `57e0bdaabe0`) depend on the unified `openai` provider, the SQLite auth store and the `provider-catalog-live-runtime` SDK, none of which exist in the fork. |
| Rebase onto `v2026.10.3` | Large | About 33 merge conflicts, including every memory and Discord seam. Requires the Node 24 upgrade, the `2026.9.5` bridge, and the one-way SQLite auth migration (`doctor --fix`). It also renames `openai-codex/*` model refs to `openai/*` in config and sessions. |

The rebase is the right long-term move but deserves its own review: memory seam conflict resolution, a credential backup and migration rehearsal, and Node 24 on the VM.

4. What changed

Everything is inside the `openai` extension, using public `openclaw/plugin-sdk/*` imports only.

- `extensions/openai/openai-codex-model-discovery.ts` (new) ports upstream's discovery and adapts it to the fork:
  - **Request.** `GET https://chatgpt.com/backend-api/codex/models?client_version=0.160.0`. Headers are `Authorization: Bearer <access>` and `ChatGPT-Account-ID`, the same headers upstream uses.
  - **Row filter.** Keeps rows with visibility `list` or empty and `show_in_picker !== false`. Skips the platform-only `gpt-5.6` and `chat-latest` aliases.
  - **Model metadata.** Upstream's fallback metadata for `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-6.1-sol`, and `gpt-5.6-sol` / `-terra` / `-luna`, covering cost, context and reasoning efforts. Unknown discovered ids get zero cost, as upstream does.
  - **Context limits.** gpt-5.6 rows get upstream's Codex window: 372k native and 272k runtime.
  - **Model rows.** Rows are built on the fork's `openai-codex-responses` transport and Codex base URL.
  - **Token.** Obtained through `resolveApiKeyForProvider`, the same resolver the runtime uses, so profile order and refresh behave as normal.
  - **Cache.** Results are cached for 60 s, keyed by a SHA-256 of the endpoint, token and account. The raw token is never a key.
  - **Timeout.** 8 s.
  - **Result states.** 401/403 → `auth-rejected`. Other failures → `unavailable` and are not cached.
- `openai-codex-provider.ts`:
  - `catalog.run` writes the discovered rows into the `openai-codex` provider entry in `models.json`.
  - `augmentModelCatalog` only synthesizes the 5.4 / 5.4 Mini / 5.4 Pro / 5.5 Pro rows that the account lists. It returns none when the account is rejected.
  - `normalizeResolvedModel` maps the advertised efforts onto pi-ai's `thinkingLevelMap`, following the same pattern as the xai extension.
  - `gpt-6*` and `gpt-5.6*` count as modern Codex ids.
  - `resolveDynamicModel` and `preferRuntimeResolvedModel` are intentionally unchanged. Discovered ids resolve from the `models.json` row, so an id the account does not list stays unknown instead of being synthesized from a template.
- `thinking-policy.ts`: `gpt-6*` and `gpt-5.6*` get `xhigh`.
- Tests: `openai-codex-model-discovery.test.ts` (17 new). The two existing augment tests now await the async hook.

Not changed:
- ChatGPT OAuth login and device pairing, `refreshOAuth`, and the auth profile format.
- The memory extensions and Discord wiring.
- The separate `codex` app-server provider (`extensions/codex`). It discovers models through its bundled `@openai/codex` 0.130.0 and is out of scope.

5. Availability semantics

- **New models appear only through discovery.** GPT-5.6 / GPT-6 Sol / Luna rows appear only when the signed-in account's `/codex/models` response lists them. Nothing is advertised from static metadata alone.
- **Pro rows.** The synthetic Pro rows (`gpt-5.5-pro`, `gpt-5.4-pro`) are hidden unless discovery lists them.
- **Rejected token.** Nothing synthetic is added, and the provider keeps only the pi-ai built-ins.
- **Discovery unavailable** (network, 5xx, timeout). The previous static behavior applies, so an outage never empties the picker.
- **Residual gap.** pi-ai's built-in `gpt-5.4`, `gpt-5.4-mini` and `gpt-5.5` rows come from the core pi registry. They stay listed even if the account omits them. Hiding them needs a core catalog-filter seam. That was not added here because it would touch core outside the extension boundary. It is proposed for review.
- **No `max` effort.** pi-ai 0.73.1 has no `max` reasoning level, and an unknown level clamps to `off`. Discovered `max` efforts are kept in `compat.supportedReasoningEfforts` but not offered as a thinking level. `xhigh` is the highest selectable level.

6. Credentials

- No migration. The existing `openai-codex:*` OAuth profiles in `auth-profiles.json` are reused as they are.
- Discovery only reads a token through the standard resolver, which may refresh it exactly as a normal model call would. It never writes credentials and never logs or returns the token.
- The SQLite migration and the `openai-codex` → `openai` rename apply only if the fork is later rebased onto upstream `2026.10.x`. Back up `~/.openclaw` before that, because the migration is one way.

7. Test results (local, macOS, Node 22)

| Suite | Result |
| --- | --- |
| `test/vitest/vitest.extension-provider-openai.config.ts` | 23 files, 279/279 passed |
| OpenAI provider contract tests | 4 files, 26/26 passed |
| `test/vitest/vitest.contracts-plugin.config.ts` | 59 files, 781/781 passed |
| Agents core: model catalog, pi discovery, reasoning effort | 6 files, 40/40 passed |
| Custom memory and Discord integration set (agents, codex run-attempt, discord, acp, auto-reply, memory) | 18 files, 332/332 passed |
| `tsc --noEmit` | exit 0 (`tsgo` is killed for memory in this environment; CI runs `tsgo`) |
| `oxfmt` / `oxlint` on changed files | clean |

The tests use a fake auth profile and an injected `fetch`. **Not verified:**
- live discovery against the account;
- whether the backend accepts `gpt-5.6*` / `gpt-6*` on pi's `openai-codex-responses` transport;
- whether `client_version=0.160.0` gates any rows. That value matches the `@openai/codex` version upstream bundles;
- a real model call.

Upstream behavior to watch for on the VM:
- Upstream tests note that `gpt-6-astra` can be refused for ChatGPT-account Codex use on some paths, and upstream falls back to `gpt-6-luna`. Upstream commit `8b1add5c419` also requires discovery before offering Astra to OAuth users, which matches this branch. If Astra is listed but fails in step 6, prefer `gpt-6-sol` or `gpt-6-luna`.
- Upstream hides `gpt-5.4` on ChatGPT hosts in favor of `gpt-5.6-terra`. This branch leaves `gpt-5.4` alone, because it passed the live probe.

8. VM update instructions (after approval only)

Run these on the gateway host as the user that runs OpenClaw. Do not print or copy credential files.

1. Back up the state directory. It contains the credentials; keep the archive private.
   ```bash
   tar -czf ~/openclaw-state-backup-$(date +%Y%m%d).tgz -C ~ .openclaw
   ```
2. Deploy the branch with the same mechanism that installed `2026.5.10-beta.1`. For a source checkout:
   ```bash
   git fetch origin
   git checkout feature/openai-codex-upstream-models   # or main after merge
   pnpm install --frozen-lockfile
   pnpm build
   ```
3. Restart the gateway so the model catalog is regenerated:
   ```bash
   openclaw gateway restart
   ```
4. Check discovery. GPT-6 / GPT-5.6 ids should appear only if the account has them:
   ```bash
   openclaw models list --provider openai-codex
   openclaw models list --provider openai-codex --json
   ```
5. Check that auth still works:
   ```bash
   openclaw models status --probe --probe-provider openai-codex
   ```
6. Invoke each newly listed model (example ids):
   ```bash
   openclaw infer model run --local --model openai-codex/gpt-6-sol --prompt "Reply OK"
   openclaw infer model run --local --model openai-codex/gpt-6-luna --prompt "Reply OK"
   openclaw infer model run --local --model openai-codex/gpt-5.4 --prompt "Reply OK"
   ```
7. Only when step 6 succeeds, change the default model in config. Example: set `agents.defaults.model.primary` to `openai-codex/gpt-6-sol`, then run `openclaw gateway restart`. If that model is not discovered, leave the current default as it is.
8. Verify the memory and Discord paths with one Discord turn: the reply is delivered and the memory adapter logs a capture.

**If the model list does not change:**
- A listed model that fails at invocation means the backend rejected it on pi's transport. Remove it from config and report the error.
- An empty discovery means 401/403. Re-pair with `openclaw models auth login --provider openai-codex`.

**Rollback:**
1. Redeploy fork `main` `2d6350c546`.
2. Run `openclaw gateway restart`.
3. Restore any changed `agents.defaults.model.primary`.

No credential rollback is needed, because the branch does not change auth storage.

9. Open questions for review

- Should a core catalog-filter seam hide pi-ai built-in Codex rows that the account does not list?
- When should the rebase onto `v2026.10.3` be scheduled? It brings the Node 24 upgrade, the `2026.9.5` bridge, the SQLite auth migration and the `openai/*` model ref rename.
