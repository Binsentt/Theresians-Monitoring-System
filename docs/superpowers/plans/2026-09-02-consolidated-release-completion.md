# Consolidated Release Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Produce a local-only web release candidate and Godot test-harness freeze that enforce Philippine mobile validation, show only canonical Student quest activity, provide a safe Admin reset, and close the stated test gaps without changing Godot product source.

**Architecture:** Backend account updates preserve an unchanged legacy phone and validate only supplied or changed values. The Student Activity query and reset endpoint share one SQL predicate: a canonical game event key or a saved GameState projection with student role, quest, scene, and map. Godot corrections are restricted to tools and run through project context.

**Tech Stack:** Node 20, Express, PostgreSQL, React 18/Jest, Godot 4.6 GDScript test scenes.

---

## File map

- capstone/backend/server.js — mobile update compatibility, Student Activity predicate/query, Admin reset endpoint.
- capstone/backend/server.mobileValidation.test.js — direct API legacy versus changed mobile regressions.
- capstone/backend/server.activityLogs.test.js — canonical activity filtering, scope, reset safety and authorization tests.
- capstone/src/utils/validation.utils.js and test — browser validation decision helpers.
- capstone/src/components/ManageUsers.js, SettingsScreen.js, and tests — phone controls and legacy-preserving requests.
- capstone/src/components/ActivityLog.js, activityLog.utils.js, tests, and AdminActivityLog.js — quest presentation plus reset dialog.
- tools/first_bandit_interaction_project_context_test.gd, tools/test_profile_http_api_stub.gd, test-only context scenes, and tools/production_polish_test.gd — harness recovery only.

### Task 1: Backend phone compatibility

**Files:**
- Modify: capstone/backend/server.js lines 1139-1146, 3789-3818, and 6740-6757.
- Test: capstone/backend/server.mobileValidation.test.js.

- [ ] **Step 1: Write failing direct API tests.**

~~~js
await t.test('preserves an unchanged legacy value during an unrelated profile edit', async () => {
  // Seed old.mobile_number with '+639171234567'; omit mobile_number from PUT.
  // Assert the update receives that exact existing value and returns 200.
});
await t.test('rejects a changed legacy value before account/profile update SQL', async () => {
  // Seed legacy number; submit '0917-123-4567'.
  // Assert 400 and that UPDATE public.accounts was never queried.
});
~~~

- [ ] **Step 2: Run the focused test before implementation.**

Run: npx --no-install node --test backend/server.mobileValidation.test.js

Expected: FAIL because both update routes validate the old phone when the field is absent.

- [ ] **Step 3: Implement the common update decision.**

~~~js
const resolveMobileUpdate = ({ hasSubmittedValue, submittedValue, existingValue }) => {
  if (!hasSubmittedValue) return { mobileNumber: existingValue ?? null };
  if (String(submittedValue ?? '') === String(existingValue ?? '')) {
    return { mobileNumber: existingValue ?? null };
  }
  return normalizePhilippineMobile(submittedValue);
};
~~~

Use Object.prototype.hasOwnProperty.call(req.body, 'mobile_number') in both account and own-profile update routes. Creation continues to call normalizePhilippineMobile; no unchanged legacy phone is trimmed, rewritten, or cleared.

- [ ] **Step 4: Verify and commit.**

Run: npx --no-install node --test backend/server.mobileValidation.test.js backend/server.accountCreation.test.js

Expected: PASS for blank optional, valid 09XXXXXXXXX, every stated invalid value, unchanged legacy values, and changed legacy values.

~~~powershell
git add capstone/backend/server.js capstone/backend/server.mobileValidation.test.js
git commit -m "fix: preserve unchanged legacy mobile values"
~~~

### Task 2: Browser phone controls and edit semantics

**Files:**
- Modify: capstone/src/utils/validation.utils.js and validation.utils.test.js.
- Modify: capstone/src/components/ManageUsers.js and ManageUsers.test.js.
- Modify: capstone/src/components/SettingsScreen.js and SettingsScreen.test.js.

- [ ] **Step 1: Write failing unit and component tests.**

~~~js
expect(validatePhilippineMobileForUpdate('+639171234567', '+639171234567'))
  .toMatchObject({ isValid: true, value: '+639171234567' });
expect(validatePhilippineMobileForUpdate('0917-123-4567', '+639171234567').isValid).toBe(false);
expect(phoneInput).toHaveAttribute('inputmode', 'numeric');
expect(phoneInput).toHaveAttribute('maxlength', '11');
~~~

Cover Admin Add, Admin Edit, and Edit Profile. Assert unchanged legacy mobile is omitted from an unrelated profile request; a changed number blocks submit until canonical.

- [ ] **Step 2: Run focused tests before implementation.**

Run: npm test -- --watchAll=false --runInBand src/utils/validation.utils.test.js src/components/ManageUsers.test.js src/components/SettingsScreen.test.js

Expected: FAIL because Settings converts a legacy value to null and inputs lack the unified length contract.

- [ ] **Step 3: Implement non-mutating update validation.**

~~~js
export const validatePhilippineMobileForUpdate = (value, originalValue) => {
  const raw = String(value ?? '');
  if (raw === String(originalValue ?? '')) return { isValid: true, value: raw, error: null };
  return validatePhilippineMobile(raw);
};
~~~

Track original mobile values when each edit form opens. Use type tel, inputMode numeric, and maxLength 11 for every applicable input. Do not filter, truncate, or transform a rendered legacy value. On an actual change, use the shared validator and canonical value.

- [ ] **Step 4: Verify and commit.**

Run: same command as Step 2.

Expected: PASS.

~~~powershell
git add capstone/src/utils/validation.utils.js capstone/src/utils/validation.utils.test.js capstone/src/components/ManageUsers.js capstone/src/components/ManageUsers.test.js capstone/src/components/SettingsScreen.js capstone/src/components/SettingsScreen.test.js
git commit -m "fix: align browser mobile validation with legacy compatibility"
~~~

### Task 3: Canonical Student Quest Activity

**Files:**
- Modify: capstone/backend/server.js lines 6855-7005.
- Modify: capstone/backend/server.activityLogs.test.js.
- Modify: capstone/src/components/activityLog.utils.js, activityLog.utils.test.js, ActivityLog.js, ActivityLog.test.js, and AdminActivityLog.js.

- [ ] **Step 1: Add failing API and UI regressions.**

~~~js
assert.match(mainQuery, /al\.event_key IS NOT NULL/i);
assert.match(mainQuery, /NULLIF\(BTRIM\(al\.current_scene\), ''\) IS NOT NULL/i);
assert.doesNotMatch(mainQuery, /admin_audit_logs/i);
expect(getActivityLogActivity({ current_quest: 'Oakleaf Bandit', difficulty_level: 'Easy' }))
  .toBe('Oakleaf Bandit — Easy');
~~~

Cover canonical Tutorial event, saved Teacher House projection, saved and reloaded Bandit Easy projection, exclusion of generic website/lifecycle rows, and Admin/Teacher/Parent/Parent-Teacher scopes.

- [ ] **Step 2: Run focused tests before implementation.**

Run: npx --no-install node --test backend/server.activityLogs.test.js backend/server.canonicalStudentVisibility.test.js backend/server.analyticsAuthorization.test.js

Run: npm test -- --watchAll=false --runInBand src/components/activityLog.utils.test.js src/components/ActivityLog.test.js src/components/TeacherActivityLog.test.js src/components/ParentActivityLog.test.js

Expected: FAIL because the current query returns all activity_logs.

- [ ] **Step 3: Implement the shared deterministic source predicate.**

~~~js
const STUDENT_QUEST_ACTIVITY_SQL = [
  '(',
  'al.event_key IS NOT NULL',
  'OR (',
  "LOWER(COALESCE(al.role, '')) = 'student'",
  "AND NULLIF(BTRIM(al.current_quest), '') IS NOT NULL",
  "AND NULLIF(BTRIM(al.current_scene), '') IS NOT NULL",
  "AND NULLIF(BTRIM(al.current_map), '') IS NOT NULL",
  ')',
  ')',
].join(' ');
~~~

Append it to both data and count queries after existing authorization scope predicates. Keep admin_audit_logs out of this route. UI always renders stored current_quest, appending stored difficulty_level only when present; it never infers from a page or URL.

- [ ] **Step 4: Verify focused activity tests.**

Run: same commands as Step 2.

Expected: PASS for Tutorial, saved/loaded quest continuity, canonical difficulty, exclusion, and restrictive scope.

### Task 4: Admin-only Reset Activity Log

**Files:**
- Modify: capstone/backend/server.js beside Activity Log routes.
- Modify: capstone/backend/server.activityLogs.test.js.
- Modify: capstone/src/components/ActivityLog.js and ActivityLog.test.js.
- Modify: capstone/src/styles/activitylog.css only if existing modal classes cannot render the action.

- [ ] **Step 1: Write failing endpoint and modal tests.**

~~~js
assert.equal(teacherResponse.status, 403);
assert.equal(missingConfirmation.status, 400);
assert.match(deleteSql, /DELETE FROM public\.activity_logs/i);
assert.doesNotMatch(deleteSql, /admin_audit_logs|accounts|game_results|playtime_sessions|student_game_progress/i);
expect(confirmButton.disabled).toBe(true);
~~~

Mock a transaction client and assert BEGIN, predicate-constrained delete, COMMIT, and release; errors must issue ROLLBACK. UI test types exact uppercase RESET and checks immediate reload.

- [ ] **Step 2: Run focused tests before implementation.**

Run: npx --no-install node --test backend/server.activityLogs.test.js

Run: npm test -- --watchAll=false --runInBand src/components/ActivityLog.test.js

Expected: FAIL because the endpoint and dialog do not exist.

- [ ] **Step 3: Implement the guarded transaction and Admin-only dialog.**

~~~js
app.post('/api/activity-logs/reset', requireAccountManagementAdmin, async (req, res) => {
  if (String(req.body?.confirmation || '').trim() !== 'RESET') {
    return res.status(400).json({ error: 'Type RESET to clear Student quest activity.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM public.activity_logs al WHERE ' + STUDENT_QUEST_ACTIVITY_SQL);
    await client.query('COMMIT');
    return res.json({ success: true, deleted_count: result.rowCount || 0 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: 'Unable to reset Student quest activity.' });
  } finally {
    client.release();
  }
});
~~~

Render the action only for Admin. Explain exact deletion scope and preserved data. Reset pagination and refetch after success. The endpoint neither reads nor writes admin_audit_logs.

- [ ] **Step 4: Verify and commit activity work.**

Run: npx --no-install node --test backend/server.activityLogs.test.js backend/server.learningCycleReset.test.js backend/server.canonicalStudentVisibility.test.js

Run: npm test -- --watchAll=false --runInBand src/components/activityLog.utils.test.js src/components/ActivityLog.test.js src/components/LearningCycleResetAction.test.js

Expected: PASS; protected data remains untouched.

~~~powershell
git add capstone/backend/server.js capstone/backend/server.activityLogs.test.js capstone/src/components/activityLog.utils.js capstone/src/components/activityLog.utils.test.js capstone/src/components/ActivityLog.js capstone/src/components/ActivityLog.test.js capstone/src/components/AdminActivityLog.js capstone/src/styles/activitylog.css
git commit -m "feat: scope student quest activity and safe reset"
~~~

### Task 5: Godot harness-only corrections

**Files:**
- Modify: tools/first_bandit_interaction_project_context_test.gd.
- Modify: tools/test_profile_http_api_stub.gd.
- Create or modify: tools project-context test scenes only for Node-inheriting autoload tests.
- Modify: tools/production_polish_test.gd.

- [ ] **Step 1: Write stale-contract assertions and fixture coverage.**

~~~gdscript
var panel := oakleaf.get_node_or_null("CanvasLayer/DialoguePanel") as Control
var dialogue_label := panel.get_node_or_null("DialogueLabel") as Label
_assert(dialogue_label != null, "First Bandit uses DialoguePanel/DialogueLabel.")
~~~

~~~gdscript
"canonical_profile": {"name": "Test Student", "grade_level": "Grade 1", "section": null}
~~~

Use a bounded frame loop in production polish to wait until threaded loading is no longer in progress before freeing its test instance. A timeout is a test failure, never suppression.

- [ ] **Step 2: Run current harnesses and record pre-fix failures.**

Run: Start-Process -Wait with Godot 4.6 and project-context scene entrypoints for First Bandit, New Game, and production polish.

Expected: stale dialogue path, missing profile fixture, and loader diagnostics expose the harness failures.

- [ ] **Step 3: Repair only tools.**

Drive First Bandit through one deliberate interaction per dialogue line plus one deliberate close, then assert exactly one battle transition and Grade 1/Easy scope. Run Node-inheriting autoload tests by scene and keep extends SceneTree tests on direct script entrypoints. Do not alter any product path.

- [ ] **Step 4: Verify and commit restricted Godot changes.**

Run: First Bandit, New Game, canonical activity, production polish, Save/Load, Teacher House, mobile controls, and direct question tests in correct contexts.

Run: git diff --name-only 72614863fe0f9f9ff0d142e22ee6abb0584dfb04..HEAD

Expected: PASS, zero script/resource errors, every changed path begins tools.

~~~powershell
git add tools
git commit -m "test: repair Godot project-context harnesses"
~~~

### Task 6: Consolidated local verification

**Files:** Verify only.

- [ ] **Step 1: Run approved Lesson Manager lifecycle regressions under Node 20.**

Run focused existing tests for Grade/Difficulty pools, mixed-topic Fixed DOCX/PDF, final review, Approve, Push, Active/Remove, locks, no-active-pool, and PDF/PPTX AI stubs.

Expected: PASS with OpenAI credentials blank and zero provider calls.

- [ ] **Step 2: Run full web gates.**

Run: all backend node test suites, npm test -- --watchAll=false --runInBand, npm run build, and git diff --check.

Expected: PASS; no build artifact is staged.

- [ ] **Step 3: Run full Godot gates.**

Run: isolated headless import, approved project-context suite, direct SceneTree suite excluding the live production question smoke test, validate_production_polish.ps1, validate_theresian_scene_integrity.ps1, and git diff --check.

Expected: PASS with zero script/resource diagnostics; only the recorded host root-certificate warning may remain.

- [ ] **Step 4: Perform disposable graphical inspection.**

Use the visual companion/computer-use workflow only in the imported sandbox. Inspect Settings, Teacher House, task trigger, dialogue, battle/lives, mobile controls, quest order, Save/Load, and the one decorative City wanderer. Do not save or modify scenes. Any visual discrepancy stops the release gate.

- [ ] **Step 5: Confirm delivery and safety.**

Run clean status and exact-head checks for both implementation worktrees and compare original dirty statuses with their preflight records. Report web/Godot hashes, test evidence, no-migration result, and zero push/deploy/production/publication/OpenAI/APK operations.
