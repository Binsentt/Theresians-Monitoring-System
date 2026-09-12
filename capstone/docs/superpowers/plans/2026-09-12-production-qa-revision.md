# Production QA revision pass

## Scope

Fix only the four human-QA defects reported for candidate `2a17214c3a9be732be008e5f0e516a7c3d020594`: durable lesson generation, active-student Screen Time reset semantics, Student Progress reset feedback/refresh, and deterministic graded-answer accuracy.

## Evidence

- Railway HTTP logs show `POST /api/learning-files/lesson-sources/57/generate` returning 504 after 60.101 seconds.
- The current server holds generation open through one full provider request and the UI waits for that response.
- Student Progress reset is already transactional; the client needs an explicit pending/one-refresh contract.
- Screen Time deletion currently keys off row status and does not expose the active/enrolled reset path.
- Accuracy consumers currently accept stored aggregate values rather than a single graded-answer definition.

## TDD sequence

1. Add focused RED tests for batched generation, durable asynchronous status/polling, Screen Time eligibility/reset/delete controls, reset pending/refresh behavior, and graded-answer accuracy (overall, per-map, and zero-answer N/A).
2. Implement the smallest compatible changes using existing `learning_files` generation status/idempotency columns, transactional reset/delete handlers, and a shared accuracy helper.
3. Run focused suites, then full backend/frontend suites, production build, and `git diff --check`.
4. Review the diff for protected scope and commit only source/tests/docs for this pass.

## Safety

No OpenAI requests, production writes, Railway mutations, migrations against production, Godot changes, or fixture data outside disposable local tests.
