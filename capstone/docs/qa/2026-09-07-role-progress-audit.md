# Role progress frontend audit and focused repair

Date: 2026-09-07. Canonical web application: `capstone` in `C:\Users\vince\Documents\Capstone-Project\Theresian's Quest- Web`.

Starting and verification HEAD: `ed83226bc5adaf577c05f11e3978283714cfd7b4`. Working tree was clean at the start of this audit. No root/app-local AGENTS.md was present; the supplied canonical-root and preservation instructions apply. No worktree, production endpoint, deployment, or live OpenAI call was used. Changes remain uncommitted for parent review.

## Existing routes and metric ownership

| View | Source and component |
| --- | --- |
| Admin Student Progress | `/api/students/progress?lifecycle=active`, `AdminStudentProgress.js`, shared `normalizeStudentProgressPayload` |
| Teacher Student Progress | Same list endpoint and normalizer, with backend session authorization |
| Admin/Teacher selected student | `/api/student-progress/:studentId`, both route to `StudentAnalytics.js` |
| Parent/Parent-Teacher child view | `/api/parent/children?scope=parent` for linked profiles; parent-scoped list and `/api/student-progress/:studentId?scope=parent` for selected-child detail |
| Grounded insight | Same `/api/student-progress/:studentId/ai-insight` route, parent adds `scope=parent`; UI preserves the returned insight and does not compute its evidence |

`analyticsEndpoints.js` adds a non-identity scope selector for parent context. Account identity remains in the authenticated session. No authorization or login files changed.

No frontend calculation produces Total Progress in these selected-student views: both display `metrics.totalProgress`. Accuracy uses the distinct `metrics.accuracy`. Therefore a corrected frontend cannot establish the truthful Total Progress denominator; the backend/game-state audit owns that prerequisite. This repair does not introduce a progress percentage or change a progress formula.

## Proven starting defects

Line references in this section refer to the starting HEAD.

1. `studentProgress.utils.js:100-118`, `normalizeStudentProgressRow`, overwrote both server `difficulty` and `difficulty_level` using only `resolveDifficultyFromScene`. A fixture with `difficulty_level: 'Easy'` plus a battle scene or no scene returned `Unknown`. Admin/Teacher detail used the raw server field, producing list/detail disagreement. The scene helper recognizes only Oakleaf, City, and Pinehill map names.
2. The same normalizer called `Number(null)` through `toFiniteNumber`. A real-shaped explicit-null response yielded `incorrect_answers: 0` and `performance_percentage: 0`. Scalar-null difficulty buckets also became zero; nested `{ accuracy: null }` buckets remained null. Even omitted answer totals produced an incorrect-answer zero via the nullable fallback. The existing unavailable-data UI test omitted fields, so it missed the explicit-null response path.
3. `ParentChildProgress.js:80-89` merged child-profile query fields over normalized progress-list fields. Its Current Quest at line 394 used that merged row, while lines 168-170 retained only detail metrics/insight/readiness and discarded detail progress. A mocked DOM fixture yielded Parent `CHILD_QUERY_QUEST` and StudentAnalytics `DETAIL_METRIC_QUEST` from the same detail payload.
4. Parent's existing stats at lines 379-407 omitted Current Difficulty, Correct Answers, Incorrect Answers, Completed Quests, and Difficulty Breakdown, despite receiving these deterministic metrics in selected-child detail.
5. `StudentAnalytics.js:154` used `metrics.currentQuest || progress.current_quest`, so explicit canonical null resurrected an older quest alias. The added regression test received `Stale quest alias` where the expected value was `Not available`.

## Focused repair

- `studentProgress.utils.js` now preserves unavailable values inside progress normalization, consumes the shared `row.metrics` values when present, and retains valid backend difficulty. `resolveCurrentDifficulty` is shared by lists, StudentAnalytics, and Parent Child Progress. An explicitly supplied canonical null stays unknown; only legacy rows without the canonical difficulty field use the prior map fallback. The generic numeric helper used elsewhere was left unchanged.
- Existing legacy missing-incorrect-count compatibility remains only when the server has omitted the count and finite total/correct values exist. Explicit canonical null does not invoke that fallback.
- `ParentChildProgress.js` retains selected detail progress and uses its canonical metrics/current quest. Previous selected-child metrics are cleared when detail loading starts. Missing required facts use the existing stats and panel classes; no stylesheet, overall route structure, or unrelated dashboard changed.
- Parent's Difficulty Breakdown formats backend Easy/Normal/Difficult accuracy, retaining unavailable buckets as `Not available`.
- `StudentAnalytics.js` uses the same current-difficulty resolver and preserves explicit-null canonical current quest rather than falling back to stale aliases.
- The coordinated backend contract returns `metrics.totalProgress: null` with `totalProgressUnavailableReason: 'full_game_milestones_unverified'`. Both detail views explain that full-game milestones are not yet verified. `reportedTotalProgress` is not used as a display fallback, and a 3/4 answer fixture retains 75% Accuracy. Empty activity/quiz/topic panels describe only their own missing records and do not claim that the student has never played.
- Grounded insight requests, contract, generation rules, and evidence/fingerprint calculation remain server-owned and unchanged by this frontend repair.

## Verification

Installed offline runtime verified: `C:\Users\vince\AppData\Local\Temp\tq-node-v20.20.2-win-x64\node.exe`, version `v20.20.2`. Default system Node was `v24.13.0` and was not used for verification.

Focused command, from canonical `capstone`:

```powershell
& 'C:\Users\vince\AppData\Local\Temp\tq-node-v20.20.2-win-x64\node.exe' 'node_modules\jest\bin\jest.js' --config jest.cra.config.cjs --runInBand --watchAll=false --runTestsByPath src/components/studentProgress.utils.test.js src/components/ParentChildProgress.test.js src/components/StudentAnalytics.test.js src/components/StudentProgress.ui.test.js src/components/analyticsEndpoints.test.js
```

- Baseline: 5 suites / 34 tests passed.
- First red gate: 6 expected failures / 17 passes, covering null conversion, difficulty overwrite, and Parent quest source.
- Expanded red gate: 10 expected failures / 19 passes, adding canonical metric priority, the required Parent facts, and detail current difficulty.
- Explicit-null detail quest red gate: 1 expected failure / 6 passes.
- First focused repair gate: 5 suites / 48 tests passed, 0 failures under Node 20.
- Additional Parent request-state red gate: 7 expected failures / 17 passes, covering unavailable-progress explanations, optional endpoint failure, same-child reset refresh, and late cross-child insight response.
- Empty-panel wording red gate: 2 expected failures, proving recorded answers were accompanied by a false global no-gameplay statement.
- Final focused gate adds `src/components/LearningCycleResetAction.test.js` to the command above: **6 suites / 57 tests passed, 0 failures** under Node 20.
- `git diff --check` for the changed frontend files: exit 0; only repository CRLF conversion notices.
- Tests use mocked fetch and no provider call; live OpenAI calls: 0.

The suite exercises Admin/Teacher/Parent-Teacher shared detail current difficulty, Parent/Parent-Teacher child facts, nullable accuracy/breakdown, current quest, existing selection, archive behavior, endpoint scope, optional endpoint failure, reset refresh, and insight response selection guards. Backend cross-role evidence/fingerprint equality and full frontend/backend/build gates belong to the integrating parent task. Human visual/production acceptance remains pending.

## Additional Parent defects verified and repaired within the approved scope

The integrating parent approved the following narrow repairs after their regression tests failed:

- Parent detail loading was coupled to optional quiz/topic fetch success. Independent settled results now retain available analytics; failed optional endpoints show a local unavailable message.
- The Parent detail effect did not depend on `refreshToken`. It now refetches after same-child learning-cycle reset, preserving the existing reset action, reasons, authorization, and modal behavior.
- An in-flight child insight POST could apply after a different child was selected. A request-version guard now ignores obsolete insight responses and clears the loading/error state for the new selection. The test first proved that a late Ava-only insight replaced Noah's recommendations, then verified that Noah's recommendations remained intact after repair.

## Files changed by this frontend subtask

- `src/components/studentProgress.utils.js`
- `src/components/studentProgress.utils.test.js`
- `src/components/ParentChildProgress.js`
- `src/components/ParentChildProgress.test.js`
- `src/components/StudentAnalytics.js`
- `src/components/StudentAnalytics.test.js`
- This audit document.

No Godot, map, login, leaderboard, database, deployment, or signing files were edited by this subtask.
