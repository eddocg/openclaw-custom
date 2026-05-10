# Memory Candidate Queue Adapter — Validation

1. Status
- Real bot validation completed
- Branch: `feature/memory-candidate-queue-adapter`
- Runtime: openclaw gateway on VM
- Backend: openclaw-memory-core candidate queue CLI
- DB: Postgres `openclaw_memory`

2. What was validated
Flow:

Discord bot message
-> openclaw-custom generic memory candidate queue adapter
-> memory-core CLI subprocess
-> `memory_candidate_queue_cli enqueue-pipeline`
-> Memory Router + Curation Pipeline
-> Postgres candidate queue

3. Env vars required
- `OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED=true`
- `OPENCLAW_MEMORY_CORE_DSN` (must be a real DSN including password)
- `OPENCLAW_MEMORY_PYTHON` (optional override; defaults to `python3`)
- `OPENCLAW_MEMORY_DEBUG` (optional)
- `OPENCLAW_MEMORY_ENABLED` (optional; pertains to existing semantic ingest)

Note: `OPENCLAW_MEMORY_CORE_DSN` must contain the real password. A placeholder like `YOUR_PASSWORD` leads to `connection_failed`.

4. Manual bot trigger
```
queue memory: Never work directly on main.
```

5. Validated rows

- Ignore lane:
  - `candidate_id`: `discord:msg:1503127373053296720`
  - `source_text`: `The bot candidate queue bridge test phrase is ORANGE EEL 666.`
  - `kind`: `ignore`
  - `status`: `auto_ignored`

- Canonical lane:
  - `candidate_id`: `discord:msg:1503127656479068204`
  - `source_text`: `Never work directly on main.`
  - `kind`: `canonical_proposal`
  - `status`: `queued_for_review`
  - `review_priority`: `high`
  - `confidence`: `0.85`
  - `risk_level`: `medium`

6. Safety confirmed
- No direct DB writes from `openclaw-custom` (only subprocess CLI boundary).
- Subprocess CLI boundary only (OpenClaw forwards full `process.env` to CLI).
- No semantic/canonical/episodic dispatch implemented in `openclaw-custom`.
- Existing semantic ingest adapter unchanged.
- Queue-only behavior; adapter triggers only on explicit `queue memory:`.
- Normal bot response continues even when candidate queue enqueue fails.

7. Troubleshooting notes
- If bot replies but no row appears, inspect gateway logs for `[memory-candidate-queue]` breadcrumbs.
- `connection_failed` usually means `OPENCLAW_MEMORY_CORE_DSN` is missing/wrong in the gateway process.
- Verify process environment for the gateway (e.g. `/proc/<pid>/environ` or equivalent on the host).
- Verify the CLI manually:
  - `OPENCLAW_MEMORY_PYTHON -m openclaw_memory_core.integration.memory_candidate_queue_cli enqueue-pipeline --text "..." --source "..." --candidate-id "..." --json`

8. Test snapshot
Targeted test results (validation run):
- memory adapter tests: 148 passed
- agents tests: 16 passed
- ACP tests: 68 passed
- `oxlint`: 0 warnings/errors
- `git diff --check`: clean

--- End of validation note

