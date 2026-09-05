# Grounded Student Progress AI Hardening

**Date:** 2026-09-05
**Status:** Approved design; implementation pending reviewed plan
**Scope:** Local web/backend hardening only, based on `46510db30b6989e612a2597e2d4b78321bb4d0ba`

## Purpose

Student Progress already calculates metrics on the backend and has a backend-only OpenAI Responses API integration, structured output, and `student_ai_insights` caching. The provider response is currently checked for shape and length but not for factual grounding. This design prevents an ungrounded provider response from becoming a valid, cached, user-visible insight.

The backend remains the sole owner of facts. OpenAI chooses only among backend-generated interpretation claim IDs. The backend validates those IDs and renders every user-visible sentence from deterministic templates. The provider never supplies user-visible percentage, count, topic, difficulty, quest, progress, trend, strength, weakness, or recommendation prose.

## Hard boundaries

- No migration or schema change. The existing `student_ai_insights` table is reused.
- No change to Student Progress metric formulas, role/scope authorization, Grade/Difficulty semantics, optional topic metadata, or frontend layout.
- No live provider call in tests; all provider tests use a mock `fetch` implementation.
- No production access, write, deployment, push, Godot change, signing activity, question change, Student-ID change, password change, or activity reset.
- The existing 75% weak-performance boundary is a product heuristic used only for claim eligibility. It is not a universal academic standard.

## Current grounded input inventory

`buildGroundedInsightInput` currently receives deterministic backend metrics and sends this minimized payload to the provider. It contains no student name or public ID.

| Field | Classification | Source / meaning | Grounding treatment |
| --- | --- | --- | --- |
| `grade` | categorical fact | Stored Student Progress grade | May support Grade-level wording only. |
| `results_recorded` | numeric count | Valid recorded result count | May support exact rendered count only. |
| `correct_answers` | numeric count | Backend-calculated correct answers | May support exact rendered count only. |
| `incorrect_answers` | numeric count | Backend-calculated incorrect answers | May support exact rendered count only. |
| `total_questions` | numeric count | Backend-calculated answered-question total | May support exact rendered count only. |
| `accuracy` | derived backend percentage | Deterministic result accuracy | May support exact rendered percentage and 75% eligibility. |
| `game_score` | derived backend metric | Stored/derived score metric | May support an exact rendered metric only. |
| `total_progress` | quest/progress fact | Stored Student Progress percentage | May support exact rendered progress only. |
| `completed_quests` | quest/progress count | Stored Student Progress quest count | May support exact count, never a named completed quest. |
| `current_quest` | quest/progress categorical fact | Stored current quest | May support the exact current-quest label only. |
| `difficulty_accuracy.easy` | difficulty derived percentage or unavailable | Easy aggregate accuracy | A number supports Easy claims; `null` creates an explicit no-data observation only. |
| `difficulty_accuracy.medium` | difficulty derived percentage or unavailable | Current internal Normal/Medium aggregate | Rendered as **Normal**; `null` is no-data only. |
| `difficulty_accuracy.hard` | difficulty derived percentage or unavailable | Current internal Difficult/Hard aggregate | Rendered as **Difficult**; `null` is no-data only. |
| `topic_performance[]` | optional observed topic evidence | Observed `math_topic` result labels and aggregates | A topic is claimable only when its exact observed row exists. No topic is inferred from Grade or Difficulty. |
| `playtime_minutes` | derived backend metric | Completed-session total | May support exact rendered duration only. |

The payload contains no temporal series, prior-period comparison, named quest-completion history, canonical topic ID, or proof of a topic curriculum membership. Therefore it cannot support trend, improvement, decline, named-completed-quest, or inferred-curriculum claims.

## Recommended architecture

```text
Database/game records
  -> existing deterministic metrics
  -> versioned grounded input and evidence catalog
  -> OpenAI selects permitted claim IDs only
  -> deterministic selection validation
  -> deterministic backend rendering
  -> cache only the validated rendered insight
  -> existing Student Progress UI
```

### 1. Versioned input and evidence catalog

The backend will add a grounding-policy version to the input used for `buildInsightFingerprint`. This changes the cache fingerprint for insights generated before this policy, so they are never reused as current validated insights.

From the existing payload it will build an in-memory catalog of permitted claim IDs. Each catalog entry has one category, exact source facts, and a server-side rendering template. Catalog entries are never stored as new database schema.

Catalog categories:

- **Performance observations:** exact recorded counts, accuracy, score, total progress, completed-quest count, current-quest label, recorded playtime, and recorded difficulty/topic results.
- **Positive evidence / strengths:** overall, difficulty, or observed-topic accuracy at or above 75%; and a factual completed-quest accomplishment when the count is greater than zero.
- **Negative evidence / weaknesses:** only overall, difficulty, or observed-topic accuracy strictly below 75% with recorded data.
- **No-data observations:** an exact difficulty with `null` accuracy. These are not strengths or weaknesses.
- **Recommendations:** either additional practice mechanically linked to an eligible weakness, or data-collection wording mechanically linked to an exact difficulty no-data observation.

There is intentionally no trend claim type. There is no claim type that says an unnamed/named quest was completed, reached, or defeated. There is no claim type that infers topic membership from Grade or Difficulty.

### 2. Provider contract

The Responses API JSON schema will accept only a compact claim selection object, such as:

```json
{
  "performance_claim_ids": ["overall_accuracy"],
  "strength_claim_ids": ["difficulty_easy_strength"],
  "weakness_claim_ids": ["difficulty_normal_weakness"],
  "recommendation_claim_ids": ["practice_difficulty_normal"]
}
```

The actual schema is built from the per-request catalog and enumerates only IDs valid for the relevant category. Empty Strength and Weakness arrays are valid. The prompt instructs the provider to select only relevant IDs and forbids adding prose, facts, or trend statements.

### 3. Deterministic validation and rendering

The validator rejects malformed JSON, unknown IDs, category-mismatched IDs, duplicate IDs, selections with unsupported references, and any object not conforming to the generated schema. It then renders the current public insight shape:

```json
{
  "performance_insight": "...server-rendered observation...",
  "strengths": ["...server-rendered strength..."],
  "weaknesses": ["...server-rendered weakness..."],
  "recommendations": ["...server-rendered recommendation..."]
}
```

All numeric text comes from the exact deterministic field in the catalog. Difficulty renders as Easy, Normal, or Difficult. Topic text uses only the exact observed topic label. Current-quest text uses only the exact stored current quest and calls it current, not completed. A `null` difficulty can render only an honest no-recorded-data observation or its linked data-collection recommendation.

### 4. Failure and cache safety

The endpoint keeps its current insufficient-data check and does not call the provider below the existing minimum. A provider network failure, timeout, malformed response, invalid claim selection, or rendering/validation failure returns the existing safe unavailable state. Deterministic Student Progress data remains available through the normal details endpoint.

Only a selection that passes structure validation, catalog validation, and rendering is inserted or updated in `student_ai_insights`. A failed provider response does not write the cache. No automatic regeneration attempt is needed: failing closed avoids extra quota use and an unbounded retry class.

The existing fingerprint equality and stale markers remain the cache-reuse and meaningful-change mechanism. The new policy version ensures older entries cannot be reused after this rollout.

### 5. Authorization and frontend

No route access condition changes. Admin, Teacher, Parent/Teacher in Teacher scope, Parent, and Parent/Teacher in Parent scope retain the existing server-side authorization checks. Cross-student access remains rejected.

The validated, rendered object intentionally retains the existing response shape. The current Student Progress layout and its explanatory wording stay intact. Frontend source changes are not expected; one is allowed only if a test proves the existing UI cannot truthfully display the preserved response contract.

## Verification strategy

Tests will be written before implementation and will use mocked provider responses. They cover supported and invented percentages/counts; recorded and no-data difficulty; current versus invented quest claims; observed and invented topic claims; eligible and empty strength/weakness lists; mechanically linked recommendations; forbidden trends; malformed/timeout/provider-failure paths; cache write/reuse/invalidation; and all existing role/scope cases.

The local completion gate requires focused AI and Student Progress tests, authorization tests, mocked-provider tests, full backend and frontend suites under Node 20, `npm test`, production build, and `git diff --check`. The project currently declares Node 20 but this machine presently exposes Node 24 only; Node 24 will not be substituted for the required Node 20 gate.

## Scope outcomes

- Existing deterministic Student Progress metrics remain authoritative and unchanged.
- A valid insight is fully traceable to the exact input fingerprint and backend catalog.
- Unsupported provider claims never reach the UI or cache.
- No database migration is required.
