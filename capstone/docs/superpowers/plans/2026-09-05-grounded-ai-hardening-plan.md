# Grounded Student Progress AI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each user-visible Student Progress AI insight a backend-rendered interpretation selected from deterministic evidence-backed claim IDs.

**Architecture:** Existing metric formulas remain unchanged. A new pure catalog turns the versioned grounded input into permitted observation, strength, weakness, no-data, and recommendation claims. The Responses API can select only IDs from that catalog; the backend validates the selection and renders the existing insight object before a cache write.

**Tech Stack:** Node 20, Express, PostgreSQL cache reuse, OpenAI Responses API strict JSON Schema, Node `node:test`, React/Jest.

---

## Files and responsibilities

| File | Role |
| --- | --- |
| `backend/studentAnalyticsMetrics.utils.js` | Existing authoritative metrics only; no change. |
| `backend/studentAnalyticsMetrics.utils.test.js` | Characterization test for no-data versus a recorded zero score. |
| `backend/studentAnalyticsGrounding.utils.js` | New pure catalog, selection validator, and deterministic renderer. |
| `backend/studentAnalyticsGrounding.utils.test.js` | New adversarial grounding matrix. |
| `backend/studentAnalyticsInsight.utils.js` | Versioned input and mocked-provider adapter. |
| `backend/studentAnalyticsInsight.utils.test.js` | Strict provider/timeout/schema/fingerprint tests. |
| `backend/server.js` | Existing route integration; change only if a test needs a safe error distinction. |
| `backend/server.analyticsAuthorization.test.js` | Authorization plus cache/no-cache route tests. |
| `src/components/StudentAnalytics.js` and `src/components/ParentChildProgress.js` | No source change expected because output shape is retained. |

## Provider selection contract

The provider returns no prose:

~~~json
{
  "grounding_policy_version": "grounded-claims-v1",
  "performance_claim_ids": ["overall_accuracy"],
  "strength_claim_ids": ["difficulty_easy_strength"],
  "weakness_claim_ids": ["difficulty_normal_weakness"],
  "recommendation_claim_ids": ["practice_difficulty_normal"]
}
~~~

The catalog contains only these evidence kinds:

- Performance: exact recorded counts/accuracy/score/progress/playtime, exact current quest, non-null difficulty/topic accuracy, and named-difficulty no-data observations.
- Strength: an actual recorded overall/difficulty/observed-topic accuracy at or above 75%, or a positive nonzero completed-quest count.
- Weakness: a recorded overall/difficulty/observed-topic accuracy below 75%.
- Recommendation: linked to a selected weakness, or to a selected explicit no-data observation.
- Never included: trend/improvement/decline, inferred topic/curriculum, or named quest completion/defeat/reach event.

## Task 1: Freeze authoritative metric behavior

**Files:**
- Modify: `backend/studentAnalyticsMetrics.utils.test.js`

- [ ] **Step 1: Add the failing characterization first**

~~~js
test('keeps no-data difficulty distinct from a recorded zero-percent result', () => {
  const metrics = buildStudentAnalyticsMetrics({
    progress: {},
    quizSessions: [{ score: 0, total_items: 1, difficulty: 'Easy' }],
    playtimeSessions: [],
  });

  assert.equal(metrics.difficultyBreakdown.easy.accuracy, 0);
  assert.equal(metrics.difficultyBreakdown.medium.accuracy, null);
  assert.equal(metrics.difficultyBreakdown.hard.accuracy, null);
});
~~~

- [ ] **Step 2: Run it before catalog work**

Run: `node --test backend/studentAnalyticsMetrics.utils.test.js`
Expected: PASS. A formula failure stops this workstream; do not alter metrics.

- [ ] **Step 3: Confirm the metric utility is untouched**

Confirm `toPercentage`, result-history selection, difficulty aliases, and null behavior have no diff.

## Task 2: Define red adversarial catalog tests

**Files:**
- Create: `backend/studentAnalyticsGrounding.utils.test.js`

- [ ] **Step 1: Create the fixed deterministic input fixture**

~~~js
const input = {
  grounding_policy_version: GROUNDING_POLICY_VERSION,
  grade: 'Grade 3', results_recorded: 5, correct_answers: 3,
  incorrect_answers: 2, total_questions: 5, accuracy: 60,
  game_score: 12, total_progress: 42, completed_quests: 1,
  current_quest: 'Fraction Forest',
  difficulty_accuracy: { easy: 100, medium: 50, hard: null },
  topic_performance: [{ topic: 'Fractions', accuracy: 60, correct_answers: 3, total_questions: 5 }],
  playtime_minutes: 24,
};
~~~

- [ ] **Step 2: Test exact support and adversarial rejection**

~~~js
test('renders only exact supported percentage and count facts', () => {
  const catalog = buildGroundedClaimCatalog(input);
  const insight = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['overall_accuracy', 'answer_counts'],
    strength_claim_ids: [], weakness_claim_ids: [], recommendation_claim_ids: [],
  }, catalog);
  assert.match(insight.performance_insight, /60%/);
  assert.match(insight.performance_insight, /3 correct/);
});

test('rejects invented facts, no-data weakness, stale policy, and unsupported trends', () => {
  const catalog = buildGroundedClaimCatalog(input);
  for (const selection of [
    { ...validSelection, performance_claim_ids: ['accuracy_85_percent'] },
    { ...validSelection, weakness_claim_ids: ['difficulty_hard_weakness'] },
    { ...validSelection, weakness_claim_ids: ['topic_subtraction_weakness'] },
    { ...validSelection, performance_claim_ids: ['completed_wizard_tower'] },
    { ...validSelection, performance_claim_ids: ['improving_accuracy'] },
    { ...validSelection, strength_claim_ids: ['overall_accuracy_60_strength'] },
    { ...validSelection, recommendation_claim_ids: ['practice_topic_subtraction'] },
    { ...validSelection, grounding_policy_version: 'grounded-claims-v0' },
  ]) assert.throws(() => validateClaimSelection(selection, catalog), /grounding|claim|policy/i);
});
~~~

- [ ] **Step 3: Prove the red state**

Run: `node --test backend/studentAnalyticsGrounding.utils.test.js`
Expected: FAIL because the new utility does not exist.

## Task 3: Implement the pure catalog and renderer

**Files:**
- Create: `backend/studentAnalyticsGrounding.utils.js`
- Modify: `backend/studentAnalyticsGrounding.utils.test.js`

- [ ] **Step 1: Implement fixed policy and catalog construction**

~~~js
const GROUNDING_POLICY_VERSION = 'grounded-claims-v1';
const WEAK_PERFORMANCE_THRESHOLD = 75;
const DIFFICULTY_DISPLAY = { easy: 'Easy', medium: 'Normal', hard: 'Difficult' };

function buildGroundedClaimCatalog(input) {
  const catalog = createEmptyCatalog(GROUNDING_POLICY_VERSION);
  addRecordedPerformanceClaims(catalog, input);
  addDifficultyClaims(catalog, input.difficulty_accuracy);
  addObservedTopicClaims(catalog, input.topic_performance);
  addEligibleStrengthClaims(catalog);
  addEligibleWeaknessAndRecommendationClaims(catalog);
  return freezeCatalog(catalog);
}
~~~

The helpers omit nonfinite/missing facts. A named difficulty with explicit `null` creates one no-data performance entry and a linked data-collection recommendation; it never creates a strength or weakness. An observed topic is omitted if its source label cannot produce bounded display text.

- [ ] **Step 2: Implement category and support-link validation**

~~~js
function validateClaimSelection(selection, catalog) {
  requireExactPolicyVersion(selection, catalog.policyVersion);
  const groups = normalizeSelectionGroups(selection);
  requireNonEmpty(groups.performance_claim_ids, 'performance_claim_ids');
  validateIdsForCategory(groups.performance_claim_ids, catalog.performance, 'performance');
  validateIdsForCategory(groups.strength_claim_ids, catalog.strength, 'strength');
  validateIdsForCategory(groups.weakness_claim_ids, catalog.weakness, 'weakness');
  validateIdsForCategory(groups.recommendation_claim_ids, catalog.recommendation, 'recommendation');
  rejectDuplicateIds(groups);
  requireRecommendationSupport(groups, catalog);
  return groups;
}
~~~

A weakness recommendation requires its `supportId` in `weakness_claim_ids`; a no-data recommendation requires its `supportId` in `performance_claim_ids`.

- [ ] **Step 3: Render only deterministic templates**

~~~js
function renderValidatedClaimSelection(selection, catalog) {
  const groups = validateClaimSelection(selection, catalog);
  return {
    performance_insight: renderGroup(groups.performance_claim_ids, catalog.performance, ' '),
    strengths: renderGroup(groups.strength_claim_ids, catalog.strength),
    weaknesses: renderGroup(groups.weakness_claim_ids, catalog.weakness),
    recommendations: renderGroup(groups.recommendation_claim_ids, catalog.recommendation),
  };
}
~~~

Templates insert exact catalog values only. They label medium Normal and hard Difficult, render `Current quest: ...`, and contain no trend or named-completion language.

- [ ] **Step 4: Expand and run the matrix**

Add passing coverage for supported difficulty/current-quest/observed-topic claims, empty Strength/Weakness arrays, weakness-linked recommendation, and no-data-linked recommendation. Add rejection coverage for invented count, unknown ID, wrong category, duplicate ID, absent strength evidence, absent weakness evidence, unsupported recommendation, stale policy, and all trend IDs.

Run: `node --test backend/studentAnalyticsGrounding.utils.test.js`
Expected: PASS with zero network access.

## Task 4: Convert the provider adapter

**Files:**
- Modify: `backend/studentAnalyticsInsight.utils.js`
- Modify: `backend/studentAnalyticsInsight.utils.test.js`

- [ ] **Step 1: Write mocked adapter tests before code**

~~~js
test('uses a mocked Responses API selection and returns backend-rendered text', async () => {
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics });
  const insight = await generateGroundedStudentInsight({
    input, apiKey: 'test-key',
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify(validSelectionFor(input)) }),
  });
  assert.match(insight.performance_insight, /60%/);
  assert.equal(JSON.stringify(insight).includes('85%'), false);
});
~~~

Add mocked malformed JSON, unknown ID, wrong category, stale policy, extra free-text property, timeout/network error, and non-OK response cases. Each must reject with `ANALYTICS_AI_*` and must not invoke a live fetch.

- [ ] **Step 2: Add policy version before fingerprinting**

~~~js
function buildGroundedInsightInput({ gradeLevel, metrics = {} } = {}) {
  return {
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    grade: asText(gradeLevel) || null,
    // Preserve the existing deterministic fields unchanged.
  };
}
~~~

Test identical input stable, meaningful metric change different, and old no-version input different from the policy-version input.

- [ ] **Step 3: Replace free-text schema with catalog enums**

~~~js
const catalog = buildGroundedClaimCatalog(input);
const providerInput = {
  grounding_policy_version: catalog.policyVersion,
  evidence: catalog.providerEvidence,
  permitted_claim_ids: catalog.permittedClaimIds,
};
const schema = buildClaimSelectionSchema(catalog);
~~~

The dynamic schema requires the five fields in the selection contract, uses category-specific ID enums, forbids extra properties, allows empty strengths/weaknesses/recommendations, and requires one to five performance IDs. The prompt says return IDs only, never prose.

- [ ] **Step 4: Validate then render before returning**

~~~js
const providerSelection = JSON.parse(outputText);
return renderValidatedClaimSelection(providerSelection, catalog);
~~~

Convert syntax/schema/selection/render errors to `QuestionGenerationError('ANALYTICS_AI_INVALID_RESPONSE', ...)`; retain safe diagnostics and add no automatic retry.

- [ ] **Step 5: Run adapter and catalog tests**

Run: `node --test backend/studentAnalyticsInsight.utils.test.js backend/studentAnalyticsGrounding.utils.test.js`
Expected: PASS; live OpenAI calls equal zero.

## Task 5: Prove cache safety and scope preservation

**Files:**
- Modify: `backend/server.analyticsAuthorization.test.js`
- Modify: `backend/server.js` only if a tested safe error mapping is missing

- [ ] **Step 1: Write a failing invalid-output/no-cache route test**

For an authorized Admin with five valid results, mock an unknown claim ID. Assert safe unavailable status, zero `INSERT INTO public.student_ai_insights` calls, and a deterministic-details GET that still returns metrics.

- [ ] **Step 2: Add exact cache behavior tests**

~~~js
assert.equal(generated.status, 'generated');
assert.equal(insertCalls, 1);
assert.equal(cached.status, 'cached');
assert.equal(fetchCalls, 0);
assert.equal(stale.status, 'regenerated');
~~~

A matching policy-version fingerprint returns only a rendered insight. A changed metric or old policy fingerprint returns stale/not-generated rather than exposing an old free-form cached insight.

- [ ] **Step 3: Preserve scope matrix**

Keep anonymous and Student rejection, Admin access, assigned Teacher access, Parent/Teacher Teacher scope, linked Parent access, Parent/Teacher Parent scope, and cross-student rejection. The existing route guards run before catalog/provider work.

- [ ] **Step 4: Run route tests**

Run: `node --test backend/server.analyticsAuthorization.test.js backend/server.canonicalStudentVisibility.test.js`
Expected: PASS with mocked fetch only.

## Task 6: Preserve the frontend contract

**Files:**
- Test: `src/components/StudentAnalytics.test.js`
- Test: `src/components/ParentChildProgress.test.js`
- Modify: no frontend source expected

- [ ] **Step 1: Verify the existing response shape**

Use the existing public `performance_insight`, `strengths`, `weaknesses`, and `recommendations` test fixture. Assert empty lists are honest, unavailable insight does not clear deterministic metrics, and no OpenAI key/client reference exists.

- [ ] **Step 2: Run UI tests**

Run: `npm test -- --runTestsByPath src/components/StudentAnalytics.test.js src/components/ParentChildProgress.test.js`
Expected: PASS. Make no UI implementation change when this contract passes.

## Task 7: Commit focused code and regressions

**Files:** only the changed files from Tasks 1–6.

- [ ] **Step 1: Review safety**

Run: `git diff --check` and inspect the diff.
Expected: no migration, metric-formula, UI-layout, Godot, or unrelated runtime change.

- [ ] **Step 2: Commit adapter and catalog**

~~~bash
git add backend/studentAnalyticsGrounding.utils.js backend/studentAnalyticsGrounding.utils.test.js backend/studentAnalyticsInsight.utils.js backend/studentAnalyticsInsight.utils.test.js
git commit -m "feat: ground student AI insights in claim catalog"
~~~

- [ ] **Step 3: Commit route/focused regressions**

~~~bash
git add backend/server.analyticsAuthorization.test.js backend/studentAnalyticsMetrics.utils.test.js
git commit -m "test: cover grounded student AI safety"
~~~

Do not include an unchanged frontend file. Do not create a frontend commit unless a response-contract test proves it necessary.

## Task 8: Complete the local gate and consolidated audit

**Files:** read-only audit only after Tasks 1–7.

- [ ] **Step 1: Use Node 20, not Node 24**

Run focused grounding/Student Progress/auth/account/Student-ID/password/Lesson Manager/publication/mock AI tests, full backend tests, full frontend tests, `npm test`, production build, and `git diff --check`. The declared Node 20 runtime must be located/provisioned locally before this gate; Node 24 is not a substitute.

- [ ] **Step 2: Search active source/tests for old contracts**

Use `rg` for six-only new Student IDs, 12-character password checks, required Topic/MULTI_TOPIC routing, reviewed checkbox gates, stale aliases, destructive Delete wording, fake AI, duplicate curriculum maps, and release localhost API URLs. Report only active runtime/test conflicts; do not rewrite history.

- [ ] **Step 3: Run Godot read-only verification**

Run existing Student-ID/New Game/Save-Load/RemoteSync/frozen-system harnesses from product candidate `f4c7a2d01556e468a036d221a1a7844fa9f57ea7`. Do not alter Godot product files, sign, or build an APK. Classify visual/on-device work as human QA.

- [ ] **Step 4: Final classification**

For every requested subsystem, report COMPLETE, PENDING HUMAN QA, or GENUINELY UNFINISHED with evidence. The missing approved signing identity remains a separate human-action blocker; do not generate or search broadly for a replacement.

## Regression matrix

| Requirement | Proof |
| --- | --- |
| Exact percentage/count | Templates use only deterministic catalog values. |
| Invented numeric/quest/topic/trend | Missing claim IDs reject before rendering and cache write. |
| Difficulty and no-data | Non-null renders exact accuracy; null produces no-data only. |
| 75% heuristic | At/above 75 supports Strength; below 75 supports Weakness; null supports neither. |
| Recommendation | Validator requires selected weakness or selected no-data support. |
| Topic and quest | Only observed topic and exact current-state IDs are available. |
| Cache | Policy fingerprint invalidates pre-hardening cache; valid only inserts; changed metrics go stale. |
| Provider failure | Mocked malformed/non-OK/timeout path remains unavailable while deterministic metrics persist. |
| Authorization | Existing Admin/Teacher/Parent scope/cross-student tests pass. |
| UI | Same public insight shape renders without redesign. |
| Live provider | All tests inject mocked fetch; live call count is zero. |
