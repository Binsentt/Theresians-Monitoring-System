# Final Connection and Defense Website/Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining truthful monitoring, reporting, presence, lifecycle-reset, lesson-diagnostic, canonical activity, and lease-authenticated game-leaderboard contracts without inventing data or widening authorization.

**Architecture:** Keep PostgreSQL and the existing Express lifecycle service authoritative. Extend read models and carefully scoped endpoints; reuse existing `POST /api/student-progress/bulk/reset` for Top Achievers. Render print data into one dedicated portal rather than printing dashboard DOM.

**Tech Stack:** Node/Express, PostgreSQL migrations, React, Jest, CSS print media queries, existing authenticated fetch helpers.

---

## Scope and branch boundary

Implement from an isolated website worktree based on current `origin/main`. Do
not change Godot, deploy, apply migrations, publish question sets, call OpenAI,
or perform a Student lifecycle action while developing. Preserve any user-owned
DOCX changes in the primary worktree.

## Exact files and responsibilities

| Area | Files to modify or add |
| --- | --- |
| Server routes/read models | `capstone/server.js`, `capstone/__tests__/server.test.js`, `capstone/__tests__/gameEndpoints.test.js` |
| Additive event-key schema | `capstone/migrations/012_add_activity_log_event_idempotency.sql` |
| Lesson table/eligibility | `capstone/src/components/LessonQuestionManager.js`, `capstone/src/components/LessonQuestionManager.test.js`, `capstone/src/styles/components.css` |
| Presence/Screen Time | `capstone/src/components/ScreenTimeMonitoring.js`, `capstone/src/components/ScreenTimeMonitoring.test.js`, `capstone/src/styles/components.css` |
| Print isolation | `capstone/src/components/PrintReportPortal.jsx` (new), `capstone/src/components/PrintReportPortal.test.js` (new), `capstone/src/components/TablePrintButton.jsx`, `capstone/src/components/PrintableTableReport.jsx`, `capstone/src/components/tableReporting.utils.js`, `capstone/src/styles/components.css` |
| Existing report consumers | `capstone/src/components/StudentAnalytics.js`, `capstone/src/components/StudentProgress.js`, `capstone/src/components/TopAchievers.js`, `capstone/src/components/ActivityLog.js`, `capstone/src/components/LessonQuestionManager.js`, `capstone/src/components/ManageUsers.js` and their focused tests |
| Top Achievers lifecycle action | `capstone/src/components/TopAchievers.js`, `capstone/src/components/TopAchievers.test.js`, `capstone/src/components/StudentProgressLifecycleActions.jsx`, `capstone/src/components/StudentProgressLifecycleActions.test.js` |

Do not add a leaderboard-reset table, reset-specific lifecycle service, account
data field, or browser-side authorization decision.

## Task 1: heartbeat-derived presence and exact stale-session accounting

**Files:** `capstone/server.js`; `capstone/__tests__/server.test.js`; `capstone/__tests__/gameEndpoints.test.js`; `capstone/src/components/ScreenTimeMonitoring.js`; `capstone/src/components/ScreenTimeMonitoring.test.js`.

- [ ] First add server tests for these cases, using a fixed database clock:
  - a `Playing` session with a heartbeat no older than 45 seconds is `Playing`;
  - a `Playing` session with a 46-second-old heartbeat is exposed as `Offline` with `heartbeat_stale` and contributes only through `last_heartbeat_at + 45 seconds`;
  - an expired lease is not live;
  - a cycle-mismatched session is not live;
  - a heartbeat after a stale gap finalizes the old session at its cutoff and is rejected, requiring a new `/api/playtime/start` lease;
  - a later start transaction closes a stale session before opening exactly one new session.
- [ ] Run the focused tests and confirm they fail because `getDailyPlaytimeTotals` currently counts open sessions through `NOW()`/lease expiry and the list route exposes raw status.
- [ ] Add server-only helpers near the existing playtime functions:
  - `PLAYTIME_HEARTBEAT_FRESHNESS_SECONDS = 45`;
  - a single SQL expression or helper for `effective_session_end = LEAST(expires_at, last_heartbeat_at + interval '45 seconds')`;
  - a projection predicate that requires stored Playing, no end time, unexpired lease, matching cycle, and fresh heartbeat;
  - a transactional stale-finalization helper called by both start and heartbeat before granting/resuming a lease.
- [ ] Update monitoring/list queries and daily totals to use that shared cutoff, returning safe `presence_status` and `presence_reason` only to existing authorized monitoring roles. Do not fabricate a heartbeat or mutate sessions from a dashboard read.
- [ ] Update `ScreenTimeMonitoring` to display the server field and preserve its existing print/report scope. Treat missing presence fields from older responses as the existing truthful offline/no-session state.
- [ ] Re-run focused server and component tests, including two concurrent stale-start attempts to prove there is no duplicate open lease.

## Task 2: lesson table non-overlap and publication eligibility diagnostics

**Files:** `capstone/server.js`; `capstone/__tests__/server.test.js`; `capstone/src/components/LessonQuestionManager.js`; `capstone/src/components/LessonQuestionManager.test.js`; `capstone/src/styles/components.css`.

- [ ] Add server tests for fixed-question read models returning distinct, machine-readable eligibility results: `ELIGIBLE`, `MISSING_DOCUMENT_TOPIC`, `MULTI_TOPIC_DOCUMENT`, `UNCONTROLLED_DOCUMENT_TOPIC`, and `DOCUMENT_TOPIC_MISMATCH`. Include structurally invalid rows as a separate existing validation failure, not as an inferred topic.
- [ ] Confirm the tests fail: current list data supplies only `validation_summary` and the frontend has to rely on generic disabled-action text.
- [ ] Extend the existing fixed-document publication validation helper to return `{ eligible, code, message }`, based strictly on stored parsed metadata and controlled topic validation. Reuse it for list, preview, and publish checks; publish remains backend-authoritative.
- [ ] In `LessonQuestionManager`, place the exact server message next to the disabled Push action and in Preview. Do not change uploaded question text, answers, parser extraction, or status semantics.
- [ ] Replace the fixed percentage Count/Status tracks with explicit safe widths: table minimum 1180px, Count 132px, Status 176px, Actions 236px, and flexible filename/topic tracks. Preserve horizontal scroll on the table wrapper only; do not allow document-root overflow. Use readable header wrapping or a two-line header only where it is semantically necessary.
- [ ] Add DOM/CSS-focused tests asserting the table retains discrete Count and Status tracks and eligibility messages remain tied to server codes. Add visual QA at 1440px, 1024px, 768px, and 375px with local fixtures.

## Task 3: canonical idempotent quest Activity Log endpoint

**Files:** `capstone/migrations/012_add_activity_log_event_idempotency.sql` (new); `capstone/server.js`; `capstone/__tests__/gameEndpoints.test.js`; `capstone/__tests__/server.test.js`.

- [ ] Add migration test/inspection coverage for a nullable `activity_logs.event_key` and the partial unique index `(student_id, event_key) WHERE event_key IS NOT NULL`. Verify it is additive and does not rewrite historical rows.
- [ ] Write endpoint tests before routing for `POST /api/game/activity`:
  - a valid active session plus credential and matching cycle inserts one canonical quest event;
  - a retried identical event returns success with `duplicate: true` and no second row;
  - invalid credential, ended/stale lease, mismatched Student/cycle, unknown type, missing key, and caller-provided canonical profile fields are rejected;
  - only `task_triggered`, `task_completed`, `quest_completed` are accepted;
  - persisted name/grade/section come from the canonical linked Student, never request metadata.
- [ ] Implement the migration with `IF NOT EXISTS` statements exactly as specified, then add the route adjacent to existing lease-authenticated game routes. Validate the lease through the existing server helper, resolve canonical account metadata, and insert with `ON CONFLICT` to return idempotent success.
- [ ] Leave generic `/api/activity-logs` compatibility behavior unchanged; it is not the canonical Godot quest path.
- [ ] Run route and authorization suites. Do not apply migration 012 locally to production data or Railway.

## Task 4: lease-authenticated, privacy-safe game leaderboard

**Files:** `capstone/server.js`; `capstone/__tests__/gameEndpoints.test.js`; `capstone/__tests__/server.test.js`.

- [ ] Add tests for `POST /api/game/leaderboard` proving active-lease access succeeds and does not require a portal JWT, while no/malformed/expired/stale/cycle-mismatched lease credentials fail.
- [ ] Assert the response contains only `rank`, `display_name`, `grade`, and truthful current-cycle `progress`/`accuracy` values. Assert it never contains email, student ID, parent ID, raw account ID, management flags, historical rankings, or another Student's detailed result payload.
- [ ] Reuse the current-cycle Top Achievers query/projection with a privacy mapper; do not create a second ranking calculation. Return a truthful empty list when the authorized current cycle has no results.
- [ ] Add limits and deterministic ordering matching the existing Top Achievers query, and document a sanitized display-name rule in the endpoint tests.

## Task 5: Reset Top Achievers by reusing existing learning-cycle bulk reset

**Files:** `capstone/src/components/TopAchievers.js`; `capstone/src/components/TopAchievers.test.js`; existing `BulkStudentProgressLifecycleAction` component and its tests; no new server reset route.

- [ ] Add UI tests before changing code:
  - Admin sees Reset Top Achievers with the existing preview/reason/typed-confirmation flow;
  - Teacher sees it only with server-backed assigned scope;
  - Parent sees no control;
  - Parent/Teacher sees it only in Teacher scope;
  - the action calls `POST /api/student-progress/bulk/reset`, preserves `expected_count`, and renders the exact approved preservation warning;
  - successful response refetches Top Achievers, Progress, and lifecycle-aware data rather than inventing an empty ranking.
- [ ] Compose the existing lifecycle component into Top Achievers. Pass only the existing scope-aware request parameters; never collect Student IDs from visible table rows as the authority.
- [ ] Require reason, previewed affected count, typed `RESET`, and the existing expected-count conflict behavior. Use the exact warning approved in the specification.
- [ ] Do not add a separate leaderboard reset schema/state, direct result deletion, or client-side current-cycle calculation.
- [ ] Run server lifecycle/authorization suites and Top Achievers component tests. Confirm historical result and Screen Time assertions remain unchanged.

## Task 6: one dedicated prepared-report print portal

**Files:** `capstone/src/components/PrintReportPortal.jsx` (new); `capstone/src/components/PrintReportPortal.test.js` (new); `capstone/src/components/TablePrintButton.jsx`; `capstone/src/components/PrintableTableReport.jsx`; `capstone/src/components/tableReporting.utils.js`; `capstone/src/styles/components.css`; report consumer components/tests listed above.

- [ ] Add failing React tests that request printing two different reports in sequence and assert: exactly one `#print-report-root`; exactly one report title/table; only fully prepared authorized rows; report metadata/record count present; `afterprint`/cancel cleanup clears the root; no dashboard controls/filter/pagination/action button appears.
- [ ] Implement a document-body portal with one selected prepared report model: title, context, record count, orientation, columns, rows, and optional student header. Mount only when preparation succeeds, then call `window.print()` after layout; clear on `afterprint` and failed preparation.
- [ ] Refactor `usePreparedReportPrint` and `TablePrintButton` to prepare data first and submit it to the portal. Remove default extra `.print-only.table-print-heading` rendering so no duplicate report heading survives.
- [ ] Update print CSS so `#root` and live app chrome are hidden and `#print-report-root` alone is visible. Keep A4 portrait/landscape, black-and-white legibility, `thead { display: table-header-group; }`, and `break-inside: avoid` for cards/rows. Eliminate absolute positioning that creates leading/trailing blank pages.
- [ ] Preserve each module's current authorized complete-filter retrieval. Button labels must say `Print Current Page` only where that is genuinely the selected behavior; otherwise all filtered authorized rows are printed.
- [ ] Exercise Student Analytics, Admin/Teacher/Parent Student Progress, Top Achievers, Activity Log, Screen Time, Lesson Manager, and Manage Users with empty and nonempty fixture data.

## Task 7: complete verification and review

- [ ] Run Node 20 with `node --version`; run focused backend route/lifecycle/playtime tests and relevant frontend component tests.
- [ ] Run full backend suite, full frontend suite, `npm run build` from `capstone`, and `git diff --check`.
- [ ] Use local browser visual QA only for this website worktree: table sizes at 1440/1024/768/375, internal Preview/table scrolling, print preview single-report isolation, and no root horizontal overflow. Do not treat browser fixtures as production role verification.
- [ ] Review `git diff --name-only` to ensure only files in this plan (and directly required focused tests) changed. Verify the primary worktree's unrelated Set A DOCX is still modified and unstaged, untouched by this branch.

## Commit and deployment strategy

1. Commit migration/server tests and server behavior separately from frontend/report behavior when both are green; keep the Godot implementation in its own repository/branch.
2. Request explicit approval with the exact website main commit before pushing/deploying. Migration 012 is applied only by the approved production deployment process and verified once; never rerun manually.
3. After production health and anonymous-route checks, integrate the Godot plan and request separate exact-commit approval before APK export/distribution.

## Rollback strategy

Before deployment, abandon or revert only the focused commits. After an approved deployment, application rollback may stop writing `event_key`; migration 012 remains because it is additive. Never use Reset Top Achievers, a new learning cycle, question publication, or a production Student mutation as a rollback/test mechanism.
