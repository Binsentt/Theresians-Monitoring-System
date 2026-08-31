# Exact Grade, Difficulty, and Topic Dynamic Question Architecture

**Status:** Approved product direction; specification and implementation planning only. No code, database, Godot, deployment, upload, approval, publication, or AI generation is authorized by this document.

## Purpose

Make the authoritative question-selection hierarchy exact and dynamic:

```text
Grade -> Difficulty -> Topic -> Question Set
```

A question set is scoped by one canonical tuple:

```text
{ grade_level: "Grade N", difficulty: "Easy|Normal|Difficult", math_topic: "one registry topic" }
```

The tuple, rather than a filename, set label, numeric identifier, or a broad grade pool, controls validation, review approval, publication, replacement, and the game request. A later approved replacement for the same tuple updates the active pool without an APK rebuild. It never changes another tuple.

## Audit findings

### Current scope registry

The backend authority is `backend/learningContentRules.utils.js`; the React app contains a duplicate of the same map in `src/config/gradeTopicMap.js`. Both currently define the following values:

| Grade | Easy | Normal | Difficult |
| --- | --- | --- | --- |
| Grade 1 | Basic Addition; Subtraction; Shapes; Place Value | Addition; Multiplication; Word Problems | Problem Solving (Addition and Subtraction) |
| Grade 2 | Shapes; Ordinal Numbers; Basic Addition/Subtraction | Multiplication; Division; Word Problems | Problem Solving; Multiplication; Division; Fractions |
| Grade 3 | Addition of Money; Whole Numbers | Multiplication; Division; Fractions | Multi-step Problem Solving |
| Grade 4 | Number Theory | Place Value of Whole Numbers | Reading, Writing, and Comparing Whole Numbers |
| Grade 5 | Number Theory; Basic Arithmetic | Number Theory; Basic Arithmetic | Time Conversion; Number Theory; Word Problems; Order of Operations |
| Grade 6 | Number Sense and Operations | Number Sense and Operations | Rational Numbers; Geometric Measurements |

The current Lesson-PDF topic selector is dependency-aware: it calls `getMathTopicsForGradeDifficulty(grade, difficulty)`. Fixed Questions currently selects Grade and Difficulty but derives topic from the document header; it does not present or submit the required Topic selector.

Some historical registry labels contain `/`, `and`, or commas. They are audited facts, not permission to split a document, invent aliases, or treat multiple independently selectable topics as one scope. This architecture does not alter historical records or the registry in planning. A future implementation must not expose a composite label as a new game encounter unless product policy explicitly identifies that exact label as one intentional, supported canonical topic. Until then, it must neither synthesize combined identifiers nor use them to bypass single-topic validation.

### Current behavior and gaps

- `learning_files` and `questions` already persist grade, difficulty, and topic. Existing lifecycle replacement uses this exact tuple and a transaction-bound advisory lock.
- The review-approval fingerprint includes file scope and question fields. It already becomes stale after reviewed content changes and must remain so.
- Fixed Question parsing supports only DOCX and PDF. Filename extension and content signature are used only for safe format validation; filename is not a scope-routing input. No runtime code special-cases Set A, Set B, or a learning-file id.
- Fixed Question validation checks question structure and document-header scope, but it does not independently classify each question's topic. Assigning the file topic to each parsed row can therefore conceal a mismatched arithmetic operation.
- Lesson PDF generation receives Grade, Difficulty, Topic, and question count in its prompt, but the backend currently persists one source/upload record as the generated set. The same uploaded lesson cannot be selected later as a durable reusable source that creates isolated generated sets.
- The game backend can query an exact grade/difficulty/topic set, but current Godot task configuration can omit `topic`; an incomplete request may therefore be broader than the planned contract.

## Non-negotiable invariants

1. Every new Fixed Question upload selects Grade, Difficulty, and Topic before upload. The backend validates the exact tuple before reading or writing question data.
2. A Fixed Question document is one candidate question set for exactly one tuple. The document header is corroborating scope evidence, not an alternative routing source. It must agree with the selected tuple.
3. Every parsed question must be assessed against the selected scope. A deterministic matcher may return `match`, `mismatch`, or `unverified`; it must never guess, re-label a question, fabricate metadata, or split a document. A detected subtraction question in a Basic Addition set identifies its original question number and blocks that set from game publication.
4. Structural review validation remains distinct from publication eligibility:
   - Structural failures include absent question text, other than four nonempty distinct choices, an unmapped correct answer, invalid Grade/Difficulty metadata, or a question record whose Grade/Difficulty metadata conflicts with the set.
   - Scope failures such as missing, mismatched, multi-topic, uncontrolled, or unverified document/topic evidence are publication blockers unless the approved structural specification explicitly classifies their per-question metadata failure as structural.
   - Thus a structurally valid genuinely mixed-topic document may be **Approved** but remains ineligible for **Push to Game** with `MULTI_TOPIC_DOCUMENT` (or a precise question-scope blocker). Approval never publishes.
5. `Needs Correction` is reserved for structural errors. Publication-only messages name the actual scope blocker and leave approval state truthful.
6. A reusable Lesson PDF is source material, not itself a publishable question set. Every generation selects the full tuple and a count, produces one separate, isolated generated question set, and must pass the same structural and deterministic scope validation before it can be approved or published.
7. A battle requests questions only with all three canonical values. The server returns questions from the one active, exact-scope set, not by filename, learning-file id, or a broader fallback query.
8. Admin, Teacher, and Parent-Teacher **Teacher scope** retain the existing manager permissions. Parent-Teacher Parent scope, Parent, Student, and unauthenticated manager requests remain denied. The public game endpoint does not grant manager capabilities.

## Fixed Questions design

The manager's Fixed Questions form must render the existing dependent controls in order: Grade, Difficulty, Topic. Topic is disabled until Grade and Difficulty are valid, then offers only the existing registry values for that pair. Changing Grade or Difficulty clears an invalid topic. Upload sends all three values and the expected source type.

The parser remains DOCX/PDF-only and does not advertise `.doc`. It retains source order as `source_index` so any diagnostic is presented as `Question N`. The server performs, in order:

1. content-signature/MIME/extension validation;
2. canonical tuple validation;
3. text extraction and structural parsing;
4. document-header comparison with the selected tuple;
5. deterministic per-question scope assessment; and
6. persistence only of the selected canonical tuple, original question data, safe validation diagnostics, and no inferred replacement topic.

The deterministic scope matcher is a required new boundary, not a heuristic. It must be registry-backed and testable per supported canonical topic. Its contract is:

```js
assessQuestionScope(question, scope)
// => { status: 'match' | 'mismatch' | 'unverified',
//      detected_topic?: string, code?: string, message?: string }
```

It may report a specific detected canonical topic only when a rule proves it. A question with insufficient or unsupported evidence returns `unverified`, which blocks publication with the exact question number rather than being silently accepted. Rule coverage must be explicitly added for every topic made newly publishable; no topic is guessed from a filename, selected label, or AI prompt.

No automatic topic splitting, topic conversion, Grade/Difficulty fabrication, or title-based routing is permitted. The known 15-question Addition/Subtraction document remains a regression fixture: it is structurally valid and review-approvable, but game publication stays blocked as genuinely mixed-topic content.

## Reusable Lesson PDF and AI design

Lesson PDF source files become durable reusable sources. A source can contain more than one instructional topic; it does not receive a game scope, cannot be approved as a question set, and cannot be published. The manager lets an authorized user choose an uploaded source, then choose Grade, Difficulty, Topic, and question count for each generation.

Each generation creates a child question-set record linked to the source. The child owns its exact tuple, questions, generation status, approval state, fingerprint, preview, and publication lifecycle. Reusing one source for Basic Addition and Subtraction creates two distinct children; approving or publishing one does not alter the other. Idempotency includes actor, durable source identity/content fingerprint, exact tuple, and count.

The generation prompt must state that every question is for the requested Grade, Difficulty, and single canonical Topic, with exactly four distinct choices and one mapped answer. Prompt instructions are defense in depth only. The server parses the structured result and applies the same structural and deterministic scope assessment before a child becomes `ready_for_review`. A scope failure records a safe generation/validation error and never auto-publishes, auto-splits, or promotes the content.

## Approval and publication lifecycle

Review approval continues to be based on structural validation and the current fingerprint. Successful approval stores the fingerprint of the reviewed child/set only. Any file-scope or question-content edit causes the computed fingerprint to differ, so approval becomes non-current and publication again requires review.

Publication separately requires all existing publication gates plus a current approval and exactly one controlled canonical scope. Publication errors are safe and ordered so the first actionable blocker is shown without claiming structural invalidity. `MULTI_TOPIC_DOCUMENT`, `MISSING_DOCUMENT_TOPIC`, `UNCONTROLLED_DOCUMENT_TOPIC`, `DOCUMENT_TOPIC_MISMATCH`, `QUESTION_TOPIC_MISMATCH`, and `QUESTION_TOPIC_UNVERIFIED` are scope/publication messages, not generic `Needs Correction` messages unless an independently structural failure also exists.

Existing exact-tuple replacement remains the only activation model: a confirmed publication supersedes the active set for the same Grade/Difficulty/Topic in one transaction and leaves all other scopes active. The `published`, `publish_status`, historical game-result links, and non-repeat/random selection semantics stay intact.

## Game contract and APK consequence

The stable game request is:

```text
GET /api/game/questions?grade=Grade%201&difficulty=Easy&topic=Basic%20Addition
```

The endpoint normalizes legacy difficulty aliases only at the boundary, requires all three values for dynamic content, validates the canonical tuple, and selects one active question set for that exact scope. It must reject incomplete or invalid scope with a safe code rather than widening the pool. It returns question content and safe set identity for cache/history handling, never asks for a filename or a teacher-set label.

Godot needs a one-time configuration/code release to supply `topic` in each encounter's `question_scope` and to preserve per-scope randomized non-repeat behavior when a set is replaced. That is an initial APK change, not a rebuild for every future upload. After that release, a teacher's approved exact-scope replacement reaches the next game fetch without an APK update. This specification does not modify Godot.

## Data, migration, compatibility, and security

Reusable source/child lineage requires an additive database migration. Add `content_role` (`lesson_source` or `question_set`, defaulting existing rows to `question_set`) and nullable `source_learning_file_id` with a restrictive self-reference and index. Existing lesson-generated rows remain self-contained legacy question sets; no historical questions, approval records, active content, accounts, progress, or game results are rewritten or deleted. New source rows are excluded from approval and publication queries.

The current duplicate Grade/Difficulty/Topic maps remain an audit risk. This work must either introduce one shared generated registry artifact or add a parity test that makes a divergent frontend map fail. It must not change the Grade 1-6 progression, invent a topic mapping, or normalize a composite label into another topic without a separately approved registry decision.

All manager routes retain `requireLessonQuestionManagerAccess`, including Teacher-scope enforcement for Parent-Teacher users. Preview remains read-only and keeps its current Question 1 first-visible, inner scroll/wheel behavior, viewport anchoring, background lock, close/reopen reset, file-switch reset, footer `Download Source | Approve | Close`, and absence of a visible header X. No Reviewed checkbox state is introduced.

## Acceptance cases

| Case | Approval | Push to Game |
| --- | --- | --- |
| Structurally valid, single canonical topic, review required | Allowed | Enabled only after current approval and all other publication gates pass |
| Structurally valid, genuinely mixed topic | Allowed | Disabled; `MULTI_TOPIC_DOCUMENT` remains visible |
| Structurally invalid questions | Denied/disabled | Disabled |
| One detected Subtraction question in selected Basic Addition scope | Structural outcome unchanged if structure is valid | Disabled with `QUESTION_TOPIC_MISMATCH` naming that question |
| Topic cannot be deterministically verified | Structural outcome unchanged if structure is valid | Disabled with `QUESTION_TOPIC_UNVERIFIED` naming that question |
| Same Lesson PDF generated twice for different exact scopes | Independent per child | Independent per child; only same scope can replace same scope |

## Explicit non-goals for this planning change

- No implementation, migration execution, build, commit of runtime code, deployment, push, production read/write, upload, approval, publication, or OpenAI call.
- No Godot modification in this task.
- No automatic splitting, content repair, metadata fabrication, or change to the audited 15-question Addition/Subtraction document.
- No changes to account, player progress, game history, or authentication policy.

## Approved canonical curriculum registry addendum — 2026-08-31

This addendum is the binding curriculum contract for the exact-scope architecture. It supersedes any earlier wording in this specification that could be read as permitting a separate frontend topic map, display label as a stored scope identity, a deterministic topic classifier for every topic, or a migration/backfill without a separate review. The full approved registry and matrix are in [canonical-grade-difficulty-topic-matrix.md](../../canonical-grade-difficulty-topic-matrix.md).

### Canonical exact-scope identity

The canonical scope key is now:

```text
grade_level + difficulty + topic_id
```

Canonical Grades are `Grade 1` through `Grade 6`; canonical Difficulties are `Easy`, `Normal`, and `Difficult`. Boundary normalization accepts only the documented safe aliases, including `Medium`/`Average` -> `Normal` and `Hard` -> `Difficult`. Canonical topic IDs, display labels, explicit aliases, and all valid Grade/Difficulty/Topic memberships are backend-owned registry data.

Every individual composite label remains one topic ID. In particular, Basic Addition/Subtraction, Problem Solving (Addition and Subtraction), Number Sense and Operations, and Geometric Measurements are not decomposed or re-routed. Semicolon-separated labels in a matrix cell remain separate scopes.

### Ownership and API contract

The backend registry module is the sole runtime owner. It is exposed through read-only `GET /api/curriculum/registry`; the frontend derives its cascading Grade, Difficulty, and Topic selectors from that versioned response and submits canonical `topic_id`. It must retire its independent `gradeTopicMap.js` ownership after all consumers migrate.

For compatibility, request boundaries may normalize Grade/Difficulty aliases and resolve an exact legacy display label only when normalized Grade, normalized Difficulty, label, and registry membership uniquely identify one ID. New writes use `topic_id`. No route may widen an invalid or incomplete scope, use a filename, or infer a semantically similar topic.

### Evidence and lifecycle policy

`basic_addition` and `subtraction` retain existing deterministic arithmetic evidence. Every other Fixed Question topic must provide a parsed per-question canonical `topic_id` that equals the selected scope and is a valid matrix membership. Missing, malformed, unsupported, or mismatching metadata blocks publication truthfully; it is not fabricated from a document header, selected dropdown, filename, title, keyword, or OpenAI response.

AI-generated children instead inherit the human-selected normalized canonical tuple. The child set and its questions store that ID, use registry-derived display text in the prompt/UI, and undergo structural validation. They are not weakly reclassified after generation.

### Legacy, schema, and game constraints

The future schema change is an additive, nullable `topic_id` proposal for participating question-set and per-question records. It is not created or applied by this design update. Legacy content stays readable and unchanged; only an exact in-memory registry bridge may resolve it, and unresolved rows are blocked from publication. A data backfill requires a separate read-only audit, review of each exact write candidate, and separate approval.

Godot does not fetch the registry. It keeps only explicitly approved canonical encounter literals and normalizes legacy difficulty aliases locally before sending a request. The sole proven scope remains First Bandit: `Grade 1` / `Easy` / `basic_addition`. Other encounters remain unresolved until their pedagogical topic is explicitly approved; this addendum does not assign them a topic or change QuestionProvider history/randomization.

### Status

This is a documentation/design decision only. It changes no runtime source, schema, question, publication, deployment, APK, or production data. The approval-gated implementation sequence is [the dedicated backend-owned registry plan](../plans/2026-08-31-backend-owned-canonical-curriculum-registry.md).
