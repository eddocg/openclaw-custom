# Governed candidate queue Discord bridge design

## 1. Problem statement

When `OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED=true`, a canonical remember-style Discord message can still bypass the governed proposal bridge and land as a direct canonical memory write. That breaks the intended review gate for canonical policy/rule capture.

The minimal fix should divert only narrow, explicit canonical remember traffic into the existing `openclaw-memory-core` candidate queue pipeline. It should not broaden scope into semantic memory, episodic capture, background jobs, or proposal automation.

## 2. Observed runtime evidence

Runtime validation used this Discord message:

```text
Remember this canonical operational rule: governed proposal bridge validations must never be auto-merged and always require explicit human review.
```

Observed result:

- The content was written directly to the resolved canonical memory file (`OPENCLAW_CANONICAL_MEMORY_PATH`, defaulting to `<home>/.openclaw/workspace/MEMORY.md`).
- The governed candidate queue did not receive a new `canonical_proposal`.
- No `queued_for_review` candidate was created for operator review.

That proves the current Discord remember path is not governed by the candidate queue when queue mode is enabled.

## 3. Current direct-write behavior

Current behavior appears to be:

1. Discord inbound text enters the normal OpenClaw runtime turn path.
2. The shared semantic ingest seam sees generic `remember this` / `save this` triggers, but that seam is only for semantic-memory ingest.
3. The shared candidate queue seam is separate and currently reacts only to the explicit `queue memory:` trigger.
4. The normal agent run then continues with its regular tool set.
5. In a normal user turn, write tooling is still available, so the model can write canonical memory directly.

Net effect: canonical remember-style Discord traffic can fall through to normal model/tool behavior and bypass the governed proposal bridge entirely.

## 4. Desired governed behavior

When the candidate queue is enabled and the inbound Discord text is a narrow, explicit canonical remember message, OpenClaw should treat the message as a governed candidate submission, not as a normal agent task.

Desired behavior:

- Extract the canonical candidate text from the raw inbound message.
- Forward it to `openclaw-memory-core` through `memory_candidate_queue_cli enqueue-pipeline`.
- Create a `canonical_proposal` candidate with `queued_for_review`.
- Return a deterministic acknowledgment that the candidate was queued and not applied.
- Do not let that turn proceed to normal model execution or direct canonical file writes.

If `OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED` is false, existing behavior can remain unchanged.

## 5. Safety invariant

The bridge must preserve these hard invariants:

- Discord remember must not write `MEMORY.md` directly when candidate queue is enabled.
- Candidate queue should create `queued_for_review` `canonical_proposal`.
- `worker-plan` and `create-proposal` remain separate manual/operator steps.
- No auto-approval.
- No auto-apply.
- No scheduler or background execution.
- No semantic or episodic scope creep.

## 6. Minimal integration point to find

The minimal integration point is the existing shared early-turn runtime seam that already sees raw inbound text before model execution:

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/acp/control-plane/manager.core.ts`

Those seams already do two useful things before the main run:

- call the semantic ingest adapter with the raw prompt
- call the candidate queue adapter with the raw prompt plus source/message metadata

That makes them the smallest safe place to add a governed canonical remember bridge because they already have:

- raw inbound user text
- stable source metadata such as Discord/message ids
- a shared channel-agnostic implementation point
- execution position before the model can use normal write tools

Minimal design:

1. Add a narrow, channel-agnostic detector/router in `src/memory` for explicit canonical remember forms such as `remember this canonical ...` or `save this canonical ...`.
2. Reuse the existing candidate queue adapter and context metadata to enqueue the extracted text through `enqueue-pipeline`.
3. When that detector matches and queue mode is enabled, short-circuit the rest of the turn before normal agent/model execution begins.
4. Skip any direct canonical write path for that turn.

This keeps the change shared and runtime-level, rather than adding Discord-specific behavior or importing `openclaw-memory-core` internals into TypeScript.

## 7. Expected runtime flow

Expected governed flow:

```text
Discord remember message
-> OpenClaw runtime
-> enqueue-pipeline
-> queued_for_review canonical_proposal
-> approve
-> worker-plan
-> proposal_ready
-> create-proposal
-> proposal_created
```

Important consequence: the Discord turn ends after enqueue plus acknowledgment. The operator-driven approval and proposal-generation stages happen later and stay manual.

## 8. Non-goals

This design does not try to do any of the following:

- Convert all `remember this` traffic to governed proposals.
- Reclassify semantic-memory or episodic-memory traffic.
- Add a broad memory intent classifier in OpenClaw.
- Auto-run `worker-plan`.
- Auto-run `create-proposal`.
- Auto-approve queued candidates.
- Auto-apply proposal content to canonical memory.
- Add schedulers, polling loops, or background workers in OpenClaw.
- Add direct database writes from `openclaw-custom`.

## 9. Validation plan

Validation should prove both routing and non-bypass behavior.

### Targeted code-level validation

- Add detector tests for:
  - explicit canonical remember matches
  - generic `remember this` non-matches
  - `queue memory:` remaining separate
  - wrapped Discord prompt boundary handling
- Add shared runtime seam tests proving that, when queue mode is enabled and the canonical detector matches:
  - candidate queue enqueue is called once with raw text and Discord context
  - the normal model run does not proceed
  - direct write tooling is never reached for that turn
  - semantic ingest is not widened into canonical behavior

### Runtime validation

1. Start the gateway with `OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED=true`.
2. Send the Discord message:

   ```text
   Remember this canonical operational rule: governed proposal bridge validations must never be auto-merged and always require explicit human review.
   ```

3. Confirm the runtime emits candidate-queue breadcrumbs for the message.
4. Confirm the queue receives a new row with:
   - `kind=canonical_proposal`
   - `status=queued_for_review`
   - Discord-derived source/candidate id metadata
5. Confirm the resolved canonical memory file is unchanged after the Discord turn.
6. Confirm no proposal state advances beyond `queued_for_review` without explicit operator approval.
7. After manual `approve`, confirm the downstream manual flow remains:
   - `worker-plan`
   - `proposal_ready`
   - `create-proposal`
   - `proposal_created`

### Regression checks

- With queue mode disabled, confirm existing behavior is unchanged.
- Confirm explicit `queue memory:` still routes to the candidate queue unchanged.
- Confirm semantic-memory ingest remains separate from canonical governed proposal routing.
