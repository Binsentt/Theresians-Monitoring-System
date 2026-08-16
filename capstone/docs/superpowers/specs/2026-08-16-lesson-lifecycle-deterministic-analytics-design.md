# Lesson Lifecycle and Deterministic Analytics Design

## Scope

This change preserves the current dashboard theme, authorization middleware, Godot integration, and Railway service. It adds persistent question-set lifecycle state, removes fabricated analytics values, and adds a cacheable, user-triggered AI interpretation layer. It does not add question-set/result traceability in this phase.

## Lesson question-set lifecycle

`public.learning_files` remains the source record for a question set. It gains additive lifecycle metadata:

- `generation_status`: `not_applicable`, `generating`, `ready_for_review`, or `failed`
- `publish_status`: `staged`, `active`, or `superseded`
- `generation_failed_at` and a sanitized `generation_error_code`
- `generated_at`, `published_at`, and `published_by`

The existing `published` boolean is retained and kept in sync for legacy readers. The API derives the displayed lifecycle from these persisted values; React does not infer it.

Lesson PDF upload stores a `generating` record first. A successful, validated generation commits all questions and changes the file to `ready_for_review` plus `staged`. A provider or validation failure commits `failed` without questions and without sensitive provider details. Fixed Question File upload bypasses OpenAI, validates/parses its questions transactionally, and is immediately `not_applicable` plus `staged`.

Publishing obtains a transaction-scoped lock for the canonical `(grade, difficulty, topic)` scope, validates that the target contains valid questions, marks the prior active set as `superseded`, then marks the target `active`, records the publisher/time, and preserves the compatibility boolean. The game API continues to return only the active set for an exact scope. `Last fetched by game` is deferred because it would require a write on every game read.

## Deterministic analytics

A single backend metrics builder is the authoritative source for all detailed analytics views. It returns explicit values or a no-data state; no UI code turns missing data into zero or derives quest totals.

- Correct, incorrect, total answered, and accuracy come from aggregated valid `game_results` when they exist. If none exist, the current game-progress snapshot is used and identified as incomplete.
- Difficulty and topic accuracy use `SUM(score) / SUM(total_items)` from game results, with legacy `Normal` and `Difficult` normalized to `Medium` and `Hard`.
- Game score, current quest, total progress, and completed quests come from the latest `student_game_progress` snapshot. `progress_percentage` is preferred when Godot sent it; lesson and quest fields are stored separately and are not substituted as a conflicting total-progress formula.
- Quest-completion percentage is `null` until the game supplies an authoritative total quest denominator. The UI labels this truthfully instead of calculating `completedQuests * 10`.
- Playtime uses completed backend `playtime_sessions`; an absence of sessions is reported as incomplete rather than treated as zero gameplay.

The same metrics object is returned to Student Analytics and Parent Child Progress after existing authorization and child-ownership checks. The external six-digit Student ID remains a string at all API boundaries.

## Grounded AI insights

`public.student_ai_insights` stores a validated JSON interpretation, an opaque input fingerprint, status, generator account, and timestamps. It receives only the minimal computed metrics: grade, totals, aggregate topic and difficulty accuracy, current quest/progress, completed quests, and playtime summary. It never receives name, email, Parent ID, Student ID, password, or OTP.

An authorized user explicitly requests a generation for one in-scope student. The server requires at least five valid game-result attempts. It returns a clear insufficient-data status below that threshold. If a completed non-stale cached record has the same fingerprint, it is returned without contacting OpenAI. New result or meaningful progress writes mark cached insight stale; the next request regenerates it. The response schema requires a short insight plus bounded strengths, weaknesses, and recommendations. Provider/configuration failures return a safe unavailable state and never replace deterministic metrics with fabricated text.

## UI and responsive table

The existing Lesson & Question Manager keeps its current layout and colors. Its table receives semantic column classes and a fixed desktop min-width: a wide, ellipsized Name cell; readable topic/type/count/status/date/size cells; and visible non-wrapping actions. The wrapper scrolls horizontally only within the table on smaller viewports.

Status badges display persisted lifecycle values. Lesson rows show the source lesson and the derived generated-question-set label; fixed rows show their parsed-set status. Preview remains available before Push to Game.

Student Analytics and Child Progress render deterministic metrics with `No data yet` / `Not available` states. Their AI area contains an explicit Generate/Refresh action only where the user is authorized and a cached/insufficient/stale/unavailable state otherwise.

## Compatibility and follow-up

Godot currently sends Student ID, Parent ID, grade, current quest, save scores/totals/progress, and per-answer topic/difficulty results. It does not send a question-set identifier/version with an answer. The next smallest backward-compatible enhancement is optional `question_set_id` and `question_set_version` in the game question response, game-result payload, and `game_results` table. It is deliberately excluded from this phase.

## Verification

Targeted tests cover lifecycle transitions, same-scope replacement, fixed-file bypass, deterministic calculations including zero-data cases, stale/cache insight behavior, output validation, existing authorization, parent-child isolation, and responsive table rendering. The production build, diff check, deployment state, root health, and anonymous authorization checks are verified after deployment. Live Lesson PDF generation is only claimed if the existing provider quota permits it.
