# Student metrics backend audit — 2026-09-07

Initial read-only audit of the canonical `capstone/backend` at web HEAD `ed83226bc5adaf577c05f11e3978283714cfd7b4`; the tracked working tree was initially clean. The sections through the initial verification describe that starting baseline. The subsequent approved local repair and final verification are recorded at the end. No database, credentials, production data, dependencies, deployment, or live OpenAI call were used or changed.

## Total Progress and the reported 75%

The current backend does **not** calculate Total Progress as `correct_answers / total_questions`:

- `backend/parentIdGame.utils.js:40`, `resolveProgressPercentage`: clamp the first available numeric value in `progress_percentage`, `completion_percentage`, `lesson_progress`, `quest_progress`; otherwise return zero.
- `backend/server.js:5836`–`5850`: the progress route aliases `completion_percentage` into missing lesson/quest progress fields.
- `backend/server.js:6006`, `6033`, `6068`: the route writes the resolved value to `public.student_game_progress.progress_percentage`.
- `backend/studentAnalyticsMetrics.utils.js:87`, `122`: `buildStudentAnalyticsMetrics` reads that stored value and rounds to two decimals; it does not verify a milestone denominator or recompute it.
- `backend/server.js:1280`: `buildCanonicalStudentProgressQuery` reads the latest current-cycle snapshot and contains no accuracy-to-progress fallback.
- `backend/server.js:8032`: Parent children list separately returns that stored value as `completion_percentage`.

Consequently there is no backend-owned numerator/denominator for Total Progress. Its current source is a client-reported snapshot field, not completed canonical game milestones. Completed quests and battle outcomes do not enter this calculation. The model explicitly returns `questCompletionPercentage: null` because no denominator is defined.

Git history supports that distinction: the original helper at `92fda458e4bd6a8cf69254beb5954bb4265a4554` preferred lesson progress, then quest progress, then zero. `e374553` added explicit progress/completion priority; neither revision used answer accuracy as progress.

Synthetic Node 20 check using the actual helpers:

| Input / output | Result |
| --- | --- |
| Snapshot: progress=0, lesson=0, quest_progress=2, correct=3, total=4 | Total Progress=0; Accuracy=75 |
| Same snapshot with stored progress_percentage=75 | Total Progress=75 |

The exact production 75% provenance is **unverified**. No production record or saved game was read by this agent. It would be incorrect to assert a proven current backend `3/4` progress formula. The parent Godot audit reports that current game progress is a save/load field initialized to zero and not recalculated, so existing saved values can remain a source to investigate.

The original ZIP audit, supplied by the parent agent, found only three implemented tasks (`go-to-teachers-house`, `talk-to-the-teacher`, `first-bandit-math-challenge`) and a separate eight-step tutorial. It did not find the requested complete Boss/Teacher return/City/Pinehill progression. Three tasks must not be used as a full-game denominator. The smallest missing requirement is an authoritative finite full-game milestone list with stable IDs, completion conditions, and saved/backend completion evidence for each. Until that exists, truthful overall game progress is unknown, not an invented percentage.

## Answer accuracy and missing data

`buildStudentAnalyticsMetrics` validates result rows: total items must be a positive integer; score must be an integer from zero through total items. It sums valid `game_results.score` and `game_results.total_items`, computes incorrect as total minus correct, and computes accuracy as `round(100 * correct / total, 2)`. If there is no valid result history, it falls back to snapshot correct/total counts. `validResultCount` counts only valid per-question rows with total_items=1, as required by the existing five-result Grounded AI gate.

Difficulty breakdown normalizes Easy→easy; Normal/Medium/Average→medium; Difficult/Hard→hard. Each bucket independently sums valid result scores/items. A bucket with no answers has accuracy=null; recorded wrong answers yield a real zero. Topic metadata remains optional; only observed nonblank topics enter topic performance.

Snapshot fallback does not ensure `correct_answers <= total_questions`; a malformed saved snapshot can therefore produce >100% accuracy. Result ingestion currently clamps `percentage` and rounds counts without rejecting `score > total_items`; the shared helper filters such invalid rows, whereas Parent list SQL sums them. This is an ingestion/aggregation inconsistency, not evidence that malformed production rows exist.

## Current Difficulty

- `backend/progressScene.utils.js`, `resolveDifficultyFromScene`, maps only exact normalized scene/map basenames: `oak_leaf_village`→Easy, `city_of_knowledge`→Normal, `pinehill_village`→Difficult.
- `/api/game/progress` uses this resolver and ignores the explicit `difficulty_level` for its stored current difficulty.
- `normalizeStudentProgressRow` at `backend/server.js:1249` recomputes difficulty from scene/map and overwrites both difficulty fields, even when a stored value exists.
- `buildStudentAnalyticsMetrics` has no `currentDifficulty` field; `buildGroundedInsightInput` has no current-difficulty evidence field.
- A recognized Oakleaf scene produces Easy. An interior/battle scene with an explicit Easy field and no recognized map produces Unknown. This was reproduced with the real resolver. Actual canonical Godot scene/map payloads must determine whether that is the specific human-observed defect; do not redesign the mapping from test fixtures.
- Historical answer difficulty is correctly independent: `/api/game/result` prioritizes normalized submitted question difficulty, then scene inference. Optional `question_set_id` validates the same canonical Grade + Difficulty pool.

## Ingestion and identity trace

| Event / route | Canonical identity and scope | Stored evidence | Limits relevant to this task |
| --- | --- | --- | --- |
| Progress/save: POST `/api/game/progress` (`server.js:5823`) | Parent public code resolves an active Parent/Parent Teacher account. Public six/eight-digit Student code resolves a Parent relationship to internal `accounts.id`; existing internal-ID and name compatibility paths remain. Linked account name/grade/section override supplied metadata. Current-cycle lease/credential validates newer cycles; legacy cycle zero retains its established no-lease compatibility. | Latest `student_game_progress`: internal Student ID, canonical profile fields, current_quest, score, correct/total, accuracy, raw progress/lesson progress, completed count, playtime, scene/map/difficulty. Activity snapshot additionally stores quest_progress, description, save status and timestamps. | `quest_progress` is stored only in activity_logs, not the progress snapshot. No completed task IDs, milestone schema/version, battle ID/outcome, or question-set ID in the snapshot. current_quest can be overwritten by any accepted save; no semantic monotonic quest check. Snapshot timestamps use NOW, activity time prefers login_time then submitted timestamp. |
| Answer/result: POST `/api/game/result` (`server.js:6142`) | Parent link resolves internal Student account; canonical name/grade take precedence. Required active Playing lease must match Student ID and Parent code, credential, heartbeat, expiry, learning cycle. | `game_results`: resolved_student_id, Parent public code, canonical Student name/grade, question difficulty/topic, score/total/percentage, submitted played_at or NOW, optional question_set_id, playtime_session_id. | No quest ID, battle ID, per-answer stable event ID, selected question ID, or battle victory/defeat field. Result retries have no route-level idempotency key. Submission time is client-supplied when present. |
| Task/quest event: POST `/api/game/activity` (`server.js:6358`) | Explicit client identity fields are rejected. Active lease joins canonical account, verifies credential/current learning cycle. | activity_logs gets internal Student ID/name/grade/section, `Task Triggered`, `Task Completed`, or `Quest Completed` description, task ID in current_quest, server timestamp, unique per-student event_key. Duplicate stable event keys return 200 instead of inserting again. | Does not update student_game_progress current_quest/completed count. Does not store separate event_type/task_id/learning-cycle columns, current difficulty, battle, answers, or question_set_id. Game event key semantics are supplied by Godot. |

`resolveGameResultQuestionSet` (`server.js:1470`) permits null for legacy rows, validates a positive integer, checks the referenced learning file is active or superseded, and compares canonical Grade + Difficulty only. The foreign key from migration 004 uses ON DELETE RESTRICT. Traceability is preserved in the database; current Student detail/result-summary SELECTs and the Parent quiz SELECT do not expose question_set_id. No live ingestion or persistence was performed, so these are code and mocked route findings, not a production end-to-end PASS claim.

## Same-Student role parity and data-source defects

`requireAnalyticsAccess`, `resolveAnalyticsScope` (`server.js:840`) and `verifyScopedStudentAnalyticsAccess` (`server.js:1764`) derive roles from authenticated canonical accounts. Admin sees all; Teacher uses the existing Teacher relationship/class scope; Parent requires the actual parent-child relationship; Parent Teacher selects Parent scope with `scope=parent`, otherwise Teacher scope. Role/query/body spoofing checks are covered by passing tests. Preserve this authorization layer.

| Reader | Data/calculation | Parity consequence |
| --- | --- | --- |
| GET `/api/students/progress` | Shared latest snapshot query, then metrics with **no result history** | Admin/Teacher same endpoint uses the same facts, but accuracy/counts can lag result ingestion. Difficulty breakdown is always no-data. |
| GET `/api/student-progress/:id` | Same snapshot, first **100** result rows ascending, first 100 activity rows descending, latest 100 playtime rows | Roles share this detail calculation after access checks, but only the oldest 100 current-cycle results enter metrics. Snapshot loses precedence as soon as any valid result exists. |
| POST `/api/student-progress/:id/ai-insight` | Same snapshot, first **500** result rows ascending, latest 500 playtime rows | AI and detail can receive different facts and fingerprints for the same Student. |
| GET `/api/parent/children` | Separate SQL sums all result rows and raw snapshot progress | Independent formulas; snapshot-only answer counts are ignored; malformed rows are not validated as shared metrics validate them. Grade preference is p.grade_level before account grade, opposite the canonical query. Does not provide the complete shared metrics payload. |
| GET `/api/analytics/overview` | Snapshot-only metrics plus separate grade summary | Inherits list accuracy/progress limits. Grade summary coerces null to numeric zero before averaging, unlike the overall summary's null filtering. |

Synthetic reproduction with actual helpers: a saved 3/4 snapshot and two recorded results (one correct, one wrong) produces list accuracy=75% but detail accuracy=50%; list Easy breakdown=null but detail Easy=50%. This is an uncovered source mismatch, not a claim about the user's real counts.

With 101 answers (first 100 correct, final wrong), GET's first-100 input gives 100% accuracy; POST's first-500 input gives 99.01%; fingerprints differ. This proves the GET/AI selection limits can invalidate a freshly generated cached insight immediately. Playtime queries also differ in limits and omit the current learning-cycle filter in both routes.

Current quest in list/detail comes only from the latest progress snapshot; task events do not update it. Thus the Activity log can show a newly completed task while Student Progress still shows the previous quest until a save arrives. The exact post-battle regression requires canonical Godot evidence; do not paper over it with a backend label.

## Grounded AI preservation

`studentAnalyticsInsight.utils.js` builds deterministic evidence and hashes `JSON.stringify(input)` with SHA-256. `studentAnalyticsGrounding.utils.js` preserves policy `grounded-claims-v1`; the provider selects permitted claim IDs and the backend renders text. AI does not calculate metrics. Unknown difficulty performance is represented by null and cannot become an inferred weakness.

Current evidence includes grade, valid-result count, correct/wrong/total, accuracy, game score, total progress, completed quest count, current quest, difficulty accuracy, observed topics, and completed playtime. It currently lacks Current Difficulty and progress provenance/coverage. The result writer marks insights stale, but progress/activity writes do not explicitly do so; metrics changes still invalidate by fingerprint on the next read. A corrected evidence contract should include a deterministic metrics/progress-definition version so an insight generated under old semantics cannot be reused accidentally, while keeping `grounded-claims-v1`.

## Minimal correction plan for the parent agent

1. Obtain the missing authoritative full-game milestone definition. Until then, expose overall progress as null/unknown with explicit availability/provenance; do not substitute 3-task completion or answer accuracy. Preserve raw legacy storage/Save/Load and unrelated leaderboard behavior unless a necessary dependency is reported.
2. Build one backend Student-metrics evidence loader/aggregator used by list, detail, Parent children, AI input, and applicable summaries. Keep roles in the access/filter layer. Aggregate all current-cycle valid result rows, not different arbitrary oldest-N samples; load bounded histories separately if the UI needs them.
3. Include current quest/difficulty from the same authoritative current snapshot/scope across all readers. Confirm actual canonical Godot current_map and battle scope before altering inference or honoring explicit values. Keep performance buckets independent and no-data nullable.
4. Feed corrected deterministic metrics into Grounded AI, add a metrics-definition version/provenance to the evidence fingerprint, preserve all permitted-claim validation and mocked providers.
5. Add regression tests for stale snapshot versus fresh answers; >100/>500 answer parity; same Student across Admin/Teacher/Parent/Parent Teacher; no data and zero performance; unknown overall denominator; canonical Grade/Student/Parent identity; scope denial; quest/current-difficulty parity; corrected fingerprint invalidating old insight. Do not change authentication, lifecycle, question-set, optional Topic or Grade + Difficulty routing contracts.

## Verification performed

Runtime: `C:\Users\vince\AppData\Local\Temp\tq-node-v20.20.2-win-x64\node.exe` → **v20.20.2**. No runtime was downloaded.

The normal `node --test --test-concurrency=2 ...` runner hit sandbox `spawn EPERM` before test execution. No test failure was interpreted as a product defect. Running each existing test file directly using Node's automatic `node:test` runner avoided the subprocess restriction:

```powershell
$taskNode20 = 'C:\Users\vince\AppData\Local\Temp\tq-node-v20.20.2-win-x64\node.exe'
$taskTests = @(
  'backend/parentIdGame.utils.test.js',
  'backend/studentAnalyticsMetrics.utils.test.js',
  'backend/studentAnalyticsGrounding.utils.test.js',
  'backend/studentAnalyticsInsight.utils.test.js',
  'backend/progressScene.utils.test.js',
  'backend/server.gameProgress.test.js',
  'backend/server.parentGameResults.test.js',
  'backend/server.analyticsAuthorization.test.js',
  'backend/server.canonicalStudentVisibility.test.js',
  'backend/server.activityLogs.test.js',
  'backend/server.studentProgressLifecycle.test.js'
)
foreach ($taskTest in $taskTests) { & $taskNode20 $taskTest; if ($LASTEXITCODE -ne 0) { throw "Failed: $taskTest" } }
```

Result: **103 passed, 0 failed, 0 skipped** across the 11 files. The route tests inject `mockPool` before requiring the server and use loopback HTTP; insight tests inject provider mocks or block provider use. A further inline Node 20 assertion script reproduced the old-writer distinction, list/detail divergence, first-100/first-500 fingerprint mismatch, explicit-difficulty loss and recognized Oakleaf→Easy behavior. These are focused baseline/audit results, not implementation verification or human acceptance.

## Approved canonical local correction

After reviewing the proof, the parent agent authorized repair of the proven parity defects, verified scene mappings, and a truthful unavailable-progress policy while the full-game milestone definition remains unresolved. No finite denominator was invented.

`studentAnalyticsEvidence.service.js` now performs one shared batch load of the complete current-cycle result and playtime evidence for the canonical Student rows already authorized by the caller. It groups rows by internal Student account ID. Student list, Student detail, Parent children, analytics overview and Grounded AI generation all use this loader and the same metrics helper. It removes the different first-100/first-500 answer windows and consistently scopes completed playtime to the current learning cycle. History shown in Activity Log and Screen Time is unchanged. Parent children now uses the same canonical account-first identity/Grade/Section query while retaining its original aliases and visibility of progress-archived children.

The response contract is:

| Field | Corrected meaning |
| --- | --- |
| `metrics.accuracy` | Backend correct/answered result ratio; 3 correct and 1 incorrect remains 75%. |
| `metrics.totalProgress` | null until a verified full-game milestone denominator and completion evidence exist. |
| `metrics.reportedTotalProgress` | Preserved legacy saved percentage for traceability; never displayed as verified game completion. |
| `metrics.totalProgressVerified` | false. |
| `metrics.totalProgressSource` | `legacy_client_snapshot` when a saved percentage exists, otherwise `unavailable`. |
| `metrics.totalProgressUnavailableReason` | `full_game_milestones_unverified`. |
| Canonical read `progress_percentage` / Parent `completion_percentage` | null, consistent with the shared truthful metric. The database field and game save/write compatibility are preserved. |
| `metrics.currentDifficulty` | Recognized current map/scene scope first; validated saved difficulty for an otherwise unknown battle context; null when no supported scope exists. Existing difficulty aliases remain Easy/Normal/Difficult/Unknown. |
| `metrics.currentQuest` | The canonical latest saved current_quest, shared across roles; historical completed event labels do not redefine the current quest. |

The parent Godot audit supplied these verified aliases: `player_house`, `players_house`, `teacher_house`, `player_house_outside_door`, `teacher_house_outside_door`, and `npc_house_outside_door` are Easy; Oakleaf remains Easy, City remains Normal, and Pinehill Village/Pinehill wrapper remain Difficult. Unknown paths do not default to Easy. Current map takes precedence over a stale historical answer difficulty.

Grounded evidence keeps `grounded-claims-v1`, adds `metrics_definition_version: student-metrics-v2`, current difficulty and progress provenance, and receives total_progress=null for unverified values. The legacy reported percentage is not included in provider evidence. The catalog only permits a total-progress claim when total_progress_verified is true; current known difficulty is a backend-rendered permitted claim. The changed fingerprint invalidates prior-semantic cached insights without changing stored legacy gameplay data. No AI generation was performed outside mocked providers.

Grade summaries and analytics readiness now preserve null instead of coercing missing progress/performance to zero. No gameplay identity, authorization, publication, question-set validation, leaderboard, result-ingestion or lifecycle contract was redesigned. The progress writer's only behavior change is the approved Current Difficulty resolver.

## Final backend verification

- Five initial new endpoint regression tests failed for the expected factual mismatches before implementation. Additional tests failed before the null-progress and summary no-data corrections.
- The resulting parity suite has seven passing endpoint tests: fresh answer facts versus stale snapshot; all authorized role contexts; >100 answers; >500 answers and AI cache equality; Parent canonical Grade/facts; saved 75% retained separately while accuracy remains 75% and completion is null; null-preserving overview/readiness.
- Existing affected fixtures were updated to include internal Student IDs returned by the batch queries and to assert the approved unavailable-progress contract. No product fallback was added for deficient test fixtures.
- Full backend run under Node 20.20.2: **411 total, 410 passed, 1 skipped, 0 failed**. This includes all top-level `backend/*.test.js`, `backend/database/*.test.js`, and `backend/migrations/*.test.js`.
- Each test file ran in a fresh Node process with a fetch wrapper rejecting all outbound hosts except `127.0.0.1`, `localhost`, and `[::1]`. Tests used their existing injected DB/provider mocks. `STUDENT_ID_MIGRATION_TEST_DATABASE_URL` was cleared for the run, then restored in the shell; the disposable PostgreSQL migration test was skipped deliberately.
- `git diff --check` passed; only Git line-ending notices were printed.
- No commit, staging, migration, production write, deployment, or APK build was performed by this audit/implementation agent.

Changed backend product files: `server.js`, `progressScene.utils.js`, `studentAnalyticsMetrics.utils.js`, `studentAnalyticsInsight.utils.js`, `studentAnalyticsGrounding.utils.js`, and new `studentAnalyticsEvidence.service.js`.

Changed backend test files: `progressScene.utils.test.js`, `studentAnalyticsMetrics.utils.test.js`, `studentAnalyticsInsight.utils.test.js`, `studentAnalyticsGrounding.utils.test.js`, `server.analyticsAuthorization.test.js`, `server.parentGameResults.test.js`, `server.learningCycleReset.test.js`, and new `server.studentMetricsParity.test.js`.

The root `.gitignore` line 9 ignores `*`; the new service, new parity test and this QA note exist in the canonical tree but require explicit inclusion when the parent stages a candidate. This agent did not alter the ignore rules or index.

Remaining backend/product limits: the full-game milestone denominator and completion evidence require the user's authoritative baseline clarification; the exact production 75% source has not been verified; live end-to-end Godot ingestion and human UI/quest acceptance remain pending. Overall game completion must not be reported as solved merely because the backend now labels unsupported completion truthfully and the deterministic parity tests pass.

## Independent review correction: concurrent learning-cycle reset

Independent review identified a real race in the initial shared loader: a canonical progress row could be read in cycle 2, a reset could commit cycle 3, and the later account joins could select cycle-3 results/playtime. The response then paired the old quest/score/completed count with new answer evidence. If the new cycle had no answers, the old snapshot fallback could mask the inconsistency. A boundary copied from the old row alone would not solve this because it also includes later cycle results.

Ten endpoint regressions reproduced the issue across all five consumers (detail, list, Parent children, overview, AI), with both two new-cycle answers and zero new-cycle answers. Before the correction, all ten failed. The detail reproduction retained the old quest, score=120 and completedQuests=2, but changed accuracy from the original 60% to either 0% from the new cycle or 100% from the old snapshot fallback, and lost the original ten completed playtime minutes.

`loadStudentAnalyticsEvidence` now owns a `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` transaction. Each consumer supplies its already-scoped canonical query/parameters; the service executes that query and both answer/playtime queries on the same checked-out PostgreSQL client before committing and releasing it. Errors roll back and release the client. No preselected canonical progress rows cross into a later account snapshot. Concurrent resets may commit, but one response uses one consistent captured database snapshot, including empty-result cases. Authorization, schema, lifecycle writes, gameplay writes and provider policy were not changed by this correction.

Fresh verification after the review correction: the parity suite is **17 passed, 0 failed**. Full backend Node 20.20.2 verification is now **421 total, 420 passed, 1 skipped, 0 failed**, with the same loopback-only fetch guard and disabled disposable migration connection described above. Server/service syntax and `git diff --check` passed. This correction changes only the shared evidence service, its five server call sites, the parity test and this note relative to the reviewed candidate; no production database was contacted.
