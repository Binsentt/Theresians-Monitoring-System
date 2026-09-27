# AI Question Generation Progress Design

## Goal

Generate exactly the requested number of lesson questions, preserve successful batches across failures, and show teachers only progress measured from questions saved for the exact generated question-file row.

## Scope and constraints

- Question count remains validated by the existing 1–50 limit.
- Provider batches remain at the existing safe size of five.
- Fixed question files and unrelated generated files do not inherit generation state.
- Progress is persistent and attached to the generated question-file row.
- A partial result is never `ready_for_review`.
- QA must run on Railway `qa-owner-testing` with a distinct PostgreSQL service and volume, never on localhost or the production database.
- Live provider QA covers requested counts 5, 25, and 50, plus one partial-failure/resume case if it can be safely exercised.
- Production remains unchanged until QA passes.

## Recommended design

Use the existing generated question-file row as the durable job record. Persist requested count, lifecycle status, and completed/remaining counts on that row. After each provider batch, insert its questions and recompute the row's actual saved-question count in one database transaction; update completed/remaining counts from that count in the same transaction. The question rows remain the source of truth and the progress fields are kept transactionally consistent with them.

The generation request returns the exact generated file ID. The frontend polls only that row and displays `<saved> / <requested> generated`. On restart or an explicit retry, a row-level lock prevents duplicate workers; the worker calculates remaining work from persisted questions and generates only that remainder. The row becomes `ready_for_review` only when its actual question count exactly matches the requested count. Failure preserves already committed batches and reports the truthful partial count/status.

When complete, the row shows `<actual> / <requested> — Ready for Review` and the UI announces `<actual> questions generated successfully.` The Question Count field remains a plain numeric input with no visible `1-50` placeholder.

## Alternatives considered

1. **Keep the synchronous HTTP generation request and poll row counts.** Smaller change, but long 25/50-question requests remain vulnerable to request/proxy timeouts and do not provide a reliable resume point.
2. **Row-backed worker (recommended).** Durable per-file progress, precise polling, same-row resume, and no new infrastructure service. Requires careful per-row locking and transactional batch persistence.
3. **Separate queue service/table.** Strong worker isolation, but expands Railway infrastructure and duplicates job identity already represented by the question-file row.

## Failure and recovery

Provider or validation failure stops that generation attempt without deleting persisted questions. The row stays in a failed/partial-failed state with completed and remaining counts derived from saved rows. A later retry locks the same row, verifies its actual saved count, and requests only the missing count. A batch is either saved with its progress update or not saved; a crash cannot advance progress ahead of committed questions.

## Verification

- Deterministic tests cover exact 5/25/50 target accounting, transaction-derived progress, partial failure, same-row resume, no duplicate persisted questions, and the exact-count gate for `ready_for_review`.
- Railway QA uses only a verified separate PostgreSQL service and volume. After migration, assert the database count for each generated file ID equals 5, 25, or 50 and matches the API/UI progress.
- Production deployment is gated on passing isolated QA; no production test data or provider calls are used.
