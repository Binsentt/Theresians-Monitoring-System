# Final Connection and Defense Completion Design

## Status and boundary

This document is a reviewed design only. It authorizes no production mutation,
question publication, Student lifecycle mutation, OpenAI request, Railway
deployment, or APK build. It is based on the production application deployment
`f8702ff` and the canonical Godot release head `61c162d` observed on 2026-08-28.

The work is deliberately divided into independently testable website/backend and
Godot changes. The existing versioned learning-cycle model remains the only
lifecycle/ranking model. No second leaderboard-reset table, archive state, or
client-side ranking truth may be introduced.

## Confirmed audit findings

1. `playtime_sessions.last_heartbeat_at` already exists, but the backend treats
   every open `Playing` session as live until lease expiry. This can display a
   stale player as Playing and count inactive time.
2. Fixed-question publication requires a single controlled `math_topic`.
   A fixed document can be structurally valid while ineligible when the
   extracted document topic is absent, multi-topic, or not valid for its
   Grade/Difficulty. The local five-question Set A artifact is structurally
   valid and resolves to one controlled topic; the live upload's sanitized row
   metadata could not be queried because the available Railway read-only
   database console lacks `psql` and a usable SSH key.
3. The Lesson Manager table uses a fixed 1000px table and percentage tracks;
   `Question Count` has a no-wrap header but only a 9% track. At constrained
   widths the text can paint into the adjacent Status track.
4. Print reports are rendered beside live dashboard DOM and print CSS reveals
   every `.print-only` node. This is not an isolated print surface and risks
   duplicate/blank printer pages.
5. `RemoteSync` emits generic session activity but no canonical task/quest
   activity event. The generic activity endpoint has no event idempotency key.
6. `QuestionProvider` prevents repeats only through one global history and,
   after exhaustion, silently returns the first candidate again. It is not
   scoped by published question-set/encounter scope.
7. `GameState.current_lives` is already the canonical player-life state and is
   present in local save/load data. The remaining requirement is regression
   coverage proving ordinary battle paths do not reset it.
8. Top Achievers already uses current learning-cycle data. Existing secure bulk
   Reset All starts new cycles with reason, expected-count protection, audit,
   transactions, and role-derived scopes. The Top Achievers UI does not expose
   that intentionally destructive lifecycle action.
9. The Godot leaderboard controller calls an endpoint which requires portal
   authentication, but Godot has a playtime lease credential rather than a
   portal JWT. The current in-game remote leaderboard therefore cannot be
   relied on.

## Invariants

- The database/backend is the source of truth for lesson metadata, gameplay
  results, progress, Screen Time, lifecycle, and rankings.
- Remote questions remain primary; `res://Data/questions.json` is fallback
  only.
- The six-digit Student ID remains a string at all boundaries.
- Parent, Teacher, Admin, and Parent/Teacher scopes are server-derived; a
  client route, Student ID, or query parameter must never expand a scope.
- No UI invents metrics, recommendations, rankings, presence, or records.
- Historical game results, Screen Time sessions, Activity Logs, accounts,
  parent relationships, teacher assignments, lessons, questions, and
  publication history are retained by a ranking reset.

## 1. Lesson Manager table and eligibility diagnostics

The table will remain a horizontally scrollable local table, not a page-level
overflow container. It will use explicit non-overlapping column tracks rather
than percentage widths for Count, Status, and Actions. The `Question Count`
and `Status` headers will remain readable at desktop and narrow widths; the
wrapper, not the document root, scrolls when required.

The backend read model will expose a structured publication diagnostic for a
fixed-question file. It distinguishes:

- structurally invalid question rows;
- no topic header found;
- multi-topic header;
- a topic not controlled for its Grade/Difficulty; and
- a document topic that conflicts with the controlled game topic.

The UI will show that diagnosis next to the disabled action and in Preview. It
will not infer or silently change a topic. A valid five-question document is
eligible only after its stored controlled `math_topic` is nonempty and matches
the validated document scope.

## 2. Heartbeat-derived presence and Screen Time

The existing 15-second client heartbeat stays unchanged. The backend will use
a 45-second freshness window (three missed heartbeat intervals) as the
authoritative presence grace period.

An open lease is displayed as `Playing` only when all are true:

- stored status is `Playing`;
- no end time exists;
- the lease has not expired;
- the session learning-cycle version matches the Student's current version;
- `last_heartbeat_at` is within 45 seconds of server time.

All other open/stale records are displayed as `Offline`, with a safe
`heartbeat_stale` reason available to authorized monitoring UI. A stale session
counts only through `min(expires_at, last_heartbeat_at + 45 seconds)`, not to
the time someone opens the dashboard.

Heartbeat and start requests will finalize an expired/stale open session at the
same calculated cutoff before allowing a later lease. A stale client cannot
resume and retroactively count its offline gap; it must start a fresh lease.
This is transactional and preserves prior session rows. No heartbeat is
fabricated and no current user is marked Playing merely from a stale row.

## 3. Canonical quest Activity Log contract

Add a nullable `event_key` to `activity_logs` with a unique index over
`(student_id, event_key)` where the key is non-null. Existing historical rows
remain unchanged. The key for a quest event is deterministic:

`cycle:<version>:task:<previous>:<current>:<event-type>:<event-key>`.

Godot will send canonical quest events through a dedicated
`POST /api/game/activity` endpoint. It accepts only an active playtime session
ID, its hashed credential match, the current cycle, the event type/key, and
non-authoritative display context. The server resolves the Student name, Grade,
Section, and identity from the lease/canonical account; it does not trust
caller-supplied profile metadata. It accepts only the enumerated event types
`task_triggered`, `task_completed`, and `quest_completed`; an insert conflict
returns a successful `duplicate: true` acknowledgement. The generic legacy
activity path is not used for these canonical events.

`RemoteSync` subscribes to the existing one-shot `GameState.task_state_changed`
signal. It sends only a successful state transition, never a notification
timeout, scene re-entry, dialogue render, or retry. A failed network attempt
retains the same stable key for retry, so the server protects against duplicate
logs.

## 4. Dedicated print surface

All reports will use one shared `PrintReportPortal`/prepared-report surface.
The live dashboard remains hidden during printing. Only one selected,
fully-authorized report is mounted in a top-level print root for a print call;
headers, filters, navigation, action controls, hidden modals, pagination, and
other `.print-only` nodes are excluded.

The portal receives title, context, record count, orientation, columns, and
prepared rows. It preserves full authorized filtered scope across pagination.
It supports Student Analytics, Student Progress, Top Achievers, Activity Log,
Screen Time, Lesson Manager, and Manage Users without reporting live DOM.
CSS uses A4 portrait/landscape, repeated table headers, internal-safe page
breaks, black-and-white contrast, and no blank leading/trailing report page.

## 5. Question consumption policy

Question history is keyed by exact encounter scope:
`question_set_id + grade + canonical difficulty + controlled topic`. A question
is not repeated within a scope round until every valid four-choice question in
that scope was used. On exhaustion, `QuestionProvider` emits one explicit
`question_pool_exhausted` event, clears only that scope's round history, and
starts the next round. It never silently falls back to another Grade,
Difficulty, Topic, question set, malformed question, or local content when a
valid remote scope was loaded.

An empty remote scope is a clear unavailable state rather than an invented
question. Local fallback remains available only on failed/empty remote load as
the existing development fallback contract permits. The first Bandit continues
to request Grade 1 / Easy / Basic Addition.

## 6. Player battle-life persistence

`GameState.current_lives` and `max_lives` remain the only player life source.
Lives initialize only in `start_new_game`, restore from a load, and reset on
the existing Game Over/new-game path. An ordinary encounter loss decrements the
canonical state; victory, retry, scene transition, notification, and enemy
health creation must not reset it. Enemy HP remains encounter-local. Save data
continues to persist and restore player lives exactly.

## 7. Top Achievers reset and game leaderboard

Top Achievers reset is explicitly a learning-cycle action, never a history
deletion. The UI reuses `BulkStudentProgressLifecycleAction` and the existing
`POST /api/student-progress/bulk/reset` service with no duplicate lifecycle
mutation code.

- Admin receives the control for all active applicable Students.
- Teacher receives it only for the server-derived assigned scope.
- Parent receives no control.
- Parent/Teacher receives it only in Teacher scope; Parent scope shows no
  management control and does not inherit Teacher data.

The existing affected-count preview, reason, typed `RESET` confirmation,
expected-count conflict check, transaction, learning-cycle descriptor, and
audit entry are retained. The new UI warning is exactly:

> Resetting Top Achievers starts a new learning cycle for the affected
> students. Their current progress and leaderboard ranking will restart, while
> historical results and Screen Time remain preserved.

Current-cycle Top Achievers becomes fresh because its existing query filters
against each Student's current cycle boundary. A previous-cycle Godot save is
already non-loadable and labelled `Previous Learning Cycle`; it remains
manually deletable. No global or role-management reset control appears in the
APK.

For the game, add a lease-authenticated `POST /api/game/leaderboard` endpoint.
It verifies the active session credential and current learning cycle and returns
only a ranked, privacy-safe display projection: rank, masked display name,
Grade, and truthful current-cycle progress/accuracy fields. It does not return
emails, Student IDs, Parent IDs, raw account IDs, reset controls, or portal
management data. `RemoteSync` owns the lease-authenticated request and the
Godot leaderboard controller consumes only that response.

## Authorization matrix

| Operation | Admin | Teacher | Parent | Parent/Teacher Parent scope | Parent/Teacher Teacher scope |
|---|---|---|---|---|---|
| Read Student monitoring | all authorized Students | assigned Students | linked children | linked children | assigned Students |
| Reset Top Achievers/current cycle | active applicable Students | assigned Students | no | no | assigned Students |
| Read game leaderboard | active lease only | n/a in Godot | n/a in Godot | n/a in Godot | n/a in Godot |
| Send canonical quest event | active lease only | n/a | n/a | n/a | n/a |
| Print report | authorized filtered scope | authorized filtered scope | linked children | linked children | assigned Students |

Server predicates remain authoritative. UI omission is not treated as access
control.

## Expected additive migration

`012_add_activity_log_event_idempotency.sql`:

```sql
ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS event_key VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_logs_student_event_key
  ON public.activity_logs(student_id, event_key)
  WHERE event_key IS NOT NULL;
```

No leaderboard, ranking, account, result, or playtime schema is deleted or
rewritten. `playtime_sessions.last_heartbeat_at` and learning-cycle fields
already exist, so presence requires code/tests rather than another table.

## Delivery and rollback

Deliver backend/frontend and Godot as separate commits on isolated branches.
Do not push, deploy, apply migration 012, publish questions, reset/archive/delete
real Students, create gameplay results, or build an APK in the implementation
phase. Verify all focused suites, full frontend build, Godot regression harness,
and `git diff --check` before any later deployment request.

Rollback is commit-level before deployment. After a future deployment, the
additive migration is harmless to retain; application rollback stops writing
`event_key` while historical activity rows and all lifecycle/history data stay
intact. A production learning-cycle reset is never used as a test or rollback
mechanism.
