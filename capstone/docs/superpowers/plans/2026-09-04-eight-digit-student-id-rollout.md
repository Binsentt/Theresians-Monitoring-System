# Eight-Digit Student ID Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit only new eight-digit Student IDs while preserving existing six-digit Student lookup, game, Parent-link, Save/Load, and RemoteSync compatibility.

**Architecture:** A width-only PostgreSQL migration expands the public-code column. The backend separates creation validation from existing-account lookup validation, and all account-linked records continue to use integer `accounts.id`. Parent Add Child accepts six or eight digits because it is a lookup-or-create flow; the backend always looks up first and permits a new account only for an eight-digit code. Godot accepts either existing public-code length solely for lookup and forwards the exact string unchanged.

**Tech Stack:** PostgreSQL, Node 20, Express, Jest, React, Godot 4.6 GDScript.

---

### Task 0: Lock the audited scope before changing code

**Evidence and classification:**

| Classification | Confirmed path | Required treatment |
| --- | --- | --- |
| A — creates a public Student ID | `POST /api/parent/children`; missing-account branches in `POST /api/game/progress` and `POST /api/playtime/start` | lookup 6/8 first; allow an insert only after exactly-eight validation |
| B — locates an existing public Student ID | Parent-child profile parsing and pre-insert query; profile check; learning-cycle; game progress; game result; activity ingestion; playtime; monitoring filter | use the explicit 6-or-8 lookup helper |
| C — changes a public Student ID | none — Admin Add Account and Edit User do not accept `game_student_id` | do not introduce an editing field or update path |
| D — displays/searches a public Student ID | Manage Users; Student Progress; Activity; Teacher/Parent monitoring and analytics | preserve the stored string exactly and do not impose a display/search length mutation |

**Schema audit:** `backend/Database_Table.sql` and every migration were searched for public-ID text storage. Only `accounts.game_student_id` has this role; related `student_id` columns are integer `accounts.id` relationships. `parent_id VARCHAR(6)` is a distinct Parent identifier and remains out of scope.

- [ ] Record this audit in the design document before implementation.
- [ ] Verify both isolated worktrees are clean and their bases remain `99ca606b7b63f3a0f41e13d0badb69407fd75d48` (web) and `72614863fe0f9f9ff0d142e22ee6abb0584dfb04` (Godot).
- [ ] Verify no supported web Account Create/Edit request writes `game_student_id`; do not add one.

---

### Task 1: Establish the migration safety proof

**Files:**
- Create: `backend/migrations/017_widen_game_student_id_to_eight.sql`
- Create: `backend/migrations/017_widen_game_student_id_to_eight.test.js`

- [ ] **Step 1: Write the failing migration-contract tests**

Create test cases that execute the migration against a disposable PostgreSQL schema with a nullable `VARCHAR(6)` `game_student_id` column and its partial unique index. Assert a stored `'001234'` remains unchanged, `'00123456'` inserts after migration, duplicate non-null values fail with `23505`, `NULL` inserts, and nine characters fail with `22001`.

- [ ] **Step 2: Run the migration-contract test and verify RED**

Run: `node --test backend/migrations/017_widen_game_student_id_to_eight.test.js`

Expected: FAIL because migration 017 does not exist.

- [ ] **Step 3: Add the minimal migration**

```sql
ALTER TABLE public.accounts
  ALTER COLUMN game_student_id TYPE VARCHAR(8);
```

Do not include `UPDATE`, `INSERT`, `DELETE`, a backfill, a new index, or another table.

- [ ] **Step 4: Run the migration-contract test and verify GREEN**

Run: `node --test backend/migrations/017_widen_game_student_id_to_eight.test.js`

Expected: PASS with preserved index, nullability, six-digit value, and unrelated-schema assertions.

- [ ] **Step 5: Commit the migration only**

```text
git add backend/migrations/017_widen_game_student_id_to_eight.sql backend/migrations/017_widen_game_student_id_to_eight.test.js
git commit -m "feat: widen public student id column to eight digits"
```

### Task 2: Make backend creation and lookup validators explicit

**Files:**
- Modify: `backend/parentIdGame.utils.js`
- Modify: `backend/parentIdGame.utils.test.js`
- Modify: `backend/server.js`
- Modify: `backend/server.parentChildCreation.test.js`
- Modify: `backend/server.canonicalProfileCheck.test.js`
- Modify: `backend/server.gameProgress.test.js`
- Modify: `backend/server.parentGameResults.test.js`
- Modify: `backend/server.activityLogs.test.js`
- Modify: `backend/server.playtime.test.js`

- [ ] **Step 1: Write failing helper and route tests**

Add assertions that `normalizeNewStudentCode('00123456')` succeeds and rejects `001234`, seven digits, nine digits, spaces, punctuation, and letters. Add assertions that `normalizeExistingStudentCode` accepts exactly `001234` and `00123456`, rejects seven digits, and does not change `normalizeParentCode('654321')`.

Add route tests proving profile check and learning-cycle accept six/eight codes; Parent Add Child observes an existing six/eight code before attempting an insert; and each missing-account fallback in Parent Add Child, game-progress, and playtime-start returns `Student ID must be exactly 8 digits.` for six, seven, nine, punctuation, spaces, or letters. Keep the legacy numeric internal-account fallback separate from public-code validation.

Add assertions that game-result, activity ingestion, and monitoring filters resolve six/eight public codes without converting them to numbers; unrelated profile updates do not mention or rewrite `game_student_id`; and Parent validation remains exactly six digits. Assert insert params retain a leading-zero eight-digit code unchanged, duplicate database errors remain mapped to their current safe messages, and no relationship/progress persistence SQL changes its integer `student_id` foreign-key use.

- [ ] **Step 2: Run focused backend tests and verify RED**

Run: `node --test backend/parentIdGame.utils.test.js backend/server.parentChildCreation.test.js backend/server.canonicalProfileCheck.test.js backend/server.gameProgress.test.js backend/server.parentGameResults.test.js backend/server.activityLogs.test.js backend/server.playtime.test.js`

Expected: FAIL because the two explicit Student validators do not exist and existing creation accepts six digits.

- [ ] **Step 3: Add minimal validation helpers and route use**

```js
const normalizeNewStudentCode = (value) => {
  const code = String(value || '').trim();
  return /^[0-9]{8}$/.test(code) ? code : null;
};

const normalizeExistingStudentCode = (value) => {
  const code = String(value || '').trim();
  return /^[0-9]{6}$/.test(code) || /^[0-9]{8}$/.test(code) ? code : null;
};
```

Replace `normalizeStudentCode` rather than retaining a vague shared validator. Use `normalizeExistingStudentCode` before existing-account SQL queries in Parent Add Child, profile check, learning-cycle, game progress, game result, activity ingestion, and monitoring filters. Use `normalizeNewStudentCode` immediately before every missing-account `INSERT` in Parent Add Child, game progress, and playtime start. Keep `normalizeParentCode` unchanged. Change `ensureSchema`'s `ADD COLUMN IF NOT EXISTS` declaration to `VARCHAR(8)` only; do not make application startup alter an existing column.

- [ ] **Step 4: Run focused backend tests and verify GREEN**

Run: `node --test backend/parentIdGame.utils.test.js backend/server.parentChildCreation.test.js backend/server.canonicalProfileCheck.test.js backend/server.gameProgress.test.js backend/server.parentGameResults.test.js backend/server.activityLogs.test.js backend/server.playtime.test.js`

Expected: PASS; no path can create a six-digit Student, while known six-digit Students resolve normally.

### Task 3: Preserve web creation behavior without adding Student-ID editing

**Files:**
- Modify: `src/utils/validation.utils.js`
- Modify: `src/utils/validation.utils.test.js`
- Modify: `src/components/ParentAddChildModal.js`
- Modify: `src/components/ParentAddChildModal.test.js`

- [ ] **Step 1: Write failing frontend tests**

Add tests expecting the Parent Add Child input validator to accept exactly six or eight ASCII digits, reject seven/nine/non-numeric values, and explain that a new Student must use eight digits. Add a Parent Add Child rendering assertion for numeric input, `maxLength={8}`, the six-or-eight placeholder/help text, and no mutation of an existing displayed legacy ID.

- [ ] **Step 2: Run focused frontend tests and verify RED**

Run: `npm test -- --watchAll=false src/utils/validation.utils.test.js src/components/ParentAddChildModal.test.js`

Expected: FAIL because the browser validator and field currently use only six digits.

- [ ] **Step 3: Implement the minimal mixed-flow web change**

```jsx
<input
  inputMode="numeric"
  maxLength={8}
  value={form.studentId}
  onChange={(event) => updateField('studentId', event.target.value.replace(/\D/g, ''))}
/>
```

Make the Parent Add Child client validator accept `/^[0-9]{6}$/` or `/^[0-9]{8}$/`; its user-facing guidance must say that a new Student requires eight digits. The backend remains authoritative: it looks up before any insert and rejects a missing six-digit Student rather than creating it. Do not add a Student-ID field to Manage Users, Edit User, or profile editing.

Do not touch phone validation, Grade/Section registry behavior, role/scope rules, or any unrelated profile field. Their existing focused/full tests serve as non-regression gates.

- [ ] **Step 4: Run focused frontend tests and verify GREEN**

Run: `npm test -- --watchAll=false src/utils/validation.utils.test.js src/components/ParentAddChildModal.test.js`

Expected: PASS.

### Task 4: Add Godot compatibility tests before product changes

**Files:**
- Create: `tools/student_id_compatibility_test.gd`
- Modify: `tools/new_game_online_validation_test.gd`
- Modify: `tools/test_profile_http_api_stub.gd`

- [ ] **Step 1: Write failing Godot tests**

Assert that the desired `GameState` API accepts only six or eight ASCII digits for existing Student lookup, accepts only eight for a hypothetical new code, preserves Parent exact-six validation, sanitizes Student input to eight digits, sends no request for a seven-digit value, and sends the unchanged six/eight Student code plus six-digit Parent code to `/api/game/profile/check/{student_id}`.

- [ ] **Step 2: Run focused Godot tests and verify RED**

Run the focused SceneTree script through the Godot 4.6 executable or Godot MCP: `--headless --path <isolated-godot-worktree> --script res://tools/student_id_compatibility_test.gd`. Do not open the editor merely to import the project. Immediately inspect `git diff -- project.godot scenes scripts tools`; any product-source delta outside the allowed Student-ID files is a STOP condition.

Expected: FAIL because the compatibility validators and eight-character input contract do not exist.

### Task 5: Apply the minimal frozen-Godot compatibility implementation

**Files:**
- Modify: `scenes/new_game_scene.tscn`
- Modify: `scenes/texture_rect_2.gd`
- Modify: `scripts/game_state.gd`
- Modify: `scripts/remote_sync.gd`

- [ ] **Step 1: Implement the smallest Student-ID-only changes**

Add `max_length = 8` only to `StudentIdInput`. Keep the Parent field at six. Define explicit `is_valid_existing_student_id`, `is_valid_new_student_id`, and `sanitize_student_id` functions; use existing-ID validation in New Game, Save/Load, profile checks, learning-cycle calls, playtime, results, and activity. Preserve all Parent calls to `is_valid_six_digit_id`.

Use this malformed-input message only before a request:

```gdscript
"Student ID must be either 6 or 8 digits."
```

Keep `_registration_api_error` and `HttpApi` base-URL selection unchanged, so a real localhost transport failure remains a connection message.

- [ ] **Step 2: Run focused Godot tests and verify GREEN**

Run the focused script and the existing New Game online-validation SceneTree script through Godot MCP/headless Godot. Then run the relevant Save/Load and RemoteSync harnesses. Confirm `SCRIPT ERROR: 0`, preserve debug/release base URLs, and inspect the product diff before committing.

Expected: PASS for six/eight lookup, malformed-request suppression, Parent six digits, profile request construction, Save/Load, and RemoteSync.

- [ ] **Step 3: Commit Godot changes only**

```text
git add scenes/new_game_scene.tscn scenes/texture_rect_2.gd scripts/game_state.gd scripts/remote_sync.gd tools/student_id_compatibility_test.gd tools/new_game_online_validation_test.gd tools/test_profile_http_api_stub.gd
git commit -m "feat: preserve legacy student id game compatibility"
```

### Task 5a: Verify the strict Godot matrix without visual/product changes

| Matrix items | Required proof |
| --- | --- |
| 26, 31, 32 | scene/text assertions: only Student `LineEdit.max_length` is 8; Parent remains exact-six validation; ASCII-digit sanitizer prevents longer/non-numeric values |
| 27–30, 33–35 | focused compatibility SceneTree test: 6/8 lookup succeeds; 7/non-numeric blocks before HTTP; exact 6/8 paths and six-digit Parent query are preserved |
| 36–38 | existing profile API stubs: canonical success, server validation message, and unavailable-localhost transport message remain distinct and truthful |
| 39 | existing New Game online-validation test: Tutorial/New Game transition contract is unchanged |
| 40–42 | Save/Load and RemoteSync harness assertions for unchanged six/eight public codes and internal-account persistence |

- [ ] Run all listed focused harnesses through Godot MCP or headless Godot from the isolated worktree.
- [ ] Record `SCRIPT ERROR: 0` from each run.
- [ ] Run `git diff --check` and `git diff --name-only 72614863fe0f9f9ff0d142e22ee6abb0584dfb04..HEAD` after the Godot commit; verify every product path is one of the four explicitly approved Student-ID files and every test-only path is under `tools/`.
- [ ] Do not start the normal product scene for visual QA and do not build an APK. If an importer/editor produces a delta in `project.godot` or any frozen path, stop rather than formatting or absorbing it.

### Task 6: Run local regression gates and make the web/backend compatibility commit

**Files:**
- Verify: `backend/**/*.test.js`
- Verify: `src/**/*.test.js`
- Verify: `package.json`

- [ ] **Step 1: Pin the verification runtime to Node 20**

Resolve an already-installed Node 20 executable and record `--version` before running any JavaScript test. Do not silently substitute Node 24 or a network-downloaded runtime. If Node 20 is unavailable locally, stop before claiming the Node gates passed and report that exact environmental blocker.

- [ ] **Step 2: Run the complete web/backend test matrix**

| Matrix items | Evidence command or focused suite |
| --- | --- |
| 1–6, 13–16 | helper, profile/learning-cycle, progress, result, activity, and playtime Node tests |
| 7–12 | Parent Add Child, profile, and playtime tests with explicit six/eight parameter assertions |
| 9–10 | Admin/Edit route static/request tests proving no public-ID update path is introduced |
| 17–23 | `validation.utils` and `ParentAddChildModal` React tests |
| 24–25 | existing phone/section/role-scope React and backend suites |
| migration safety | `017_widen_game_student_id_to_eight` contract/integration test |

Run:

Run:

```text
node --test backend/*.test.js backend/database/*.test.js
npm test -- --watchAll=false --runInBand
npm run build
git diff --check
```

Expected: all commands exit zero under Node 20.

- [ ] **Step 3: Inspect scope and commit web/backend compatibility code**

Verify the diff contains only migration, Student-ID validator/routes/tests, and Parent Add Child validation. Commit after the migration commit:

```text
git add backend/parentIdGame.utils.js backend/parentIdGame.utils.test.js backend/server.js backend/server.parentChildCreation.test.js backend/server.canonicalProfileCheck.test.js backend/server.playtime.test.js src/utils/validation.utils.js src/utils/validation.utils.test.js src/components/ParentAddChildModal.js src/components/ParentAddChildModal.test.js
git commit -m "feat: require eight-digit student ids for new accounts"
```

- [ ] **Step 4: Final safety report**

Record separate migration, web/backend, and Godot hashes; record test output and `git diff --check`; confirm no push, deployment, production migration, production write, APK build, or OpenAI request occurred.
