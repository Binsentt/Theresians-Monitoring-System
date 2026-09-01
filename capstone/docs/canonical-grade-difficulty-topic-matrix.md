# Theresian's Quest — Canonical Grade, Difficulty, and Topic Registry

**Status:** Historical topic-taxonomy reference. Its former Grade/Difficulty/Topic routing policy is superseded by the Grade+Difficulty active-pool design in [`docs/superpowers/specs/2026-09-01-grade-difficulty-question-pool-design.md`](superpowers/specs/2026-09-01-grade-difficulty-question-pool-design.md). No runtime, schema, deployment, or production-content change is authorized by this document.

**Decision date:** 2026-08-31
**Registry version:** `2026-08-31`
**Historical metadata key:** `grade_level + difficulty + topic_id`
**Current active-pool key:** `grade_level + difficulty`

## 1. Authority and invariants

The backend owns the one canonical curriculum registry. It is the authoritative source for:

- canonical Grade values;
- canonical Difficulty values and accepted aliases;
- canonical topic IDs, display labels, and any explicit legacy aliases; and
- the optional Grade/Difficulty/Topic membership metadata below.

The registry is a versioned, read-only backend code artifact. It is not a user-editable database table, a filename convention, an AI classification result, or a separate frontend configuration map. Topic values remain optional persisted/display metadata when present; they are not required for new question sets and are never active-pool authority.

The previous active-pool invariant was:

```text
Grade 1|Easy|basic_addition|question_set_id
```

This historical tuple is retained only for metadata compatibility. The active game-pool invariant is now `Grade 1|Easy|question_set_id`; no topic ID, display label, filename, or frontend-only mapping may form another pool. Grade/Difficulty aliases normalize at the boundary.

## 2. Canonical Grades and Difficulties

### Grades

| Canonical value | Safe boundary aliases | Stored/requested value |
| --- | --- | --- |
| `Grade 1` | `1`, `grade1`, `grade 1` | `Grade 1` |
| `Grade 2` | `2`, `grade2`, `grade 2` | `Grade 2` |
| `Grade 3` | `3`, `grade3`, `grade 3` | `Grade 3` |
| `Grade 4` | `4`, `grade4`, `grade 4` | `Grade 4` |
| `Grade 5` | `5`, `grade5`, `grade 5` | `Grade 5` |
| `Grade 6` | `6`, `grade6`, `grade 6` | `Grade 6` |

Only the six exact `Grade N` values are canonical. Trim and case-insensitive comparison are boundary normalization behavior, not extra stored Grade values.

### Difficulties

| Canonical value | Accepted legacy aliases | Stored/requested value |
| --- | --- | --- |
| `Easy` | `easy` (case-insensitive boundary form) | `Easy` |
| `Normal` | `Medium`, `Average` | `Normal` |
| `Difficult` | `Hard` | `Difficult` |

`Medium` and `Hard` are compatibility inputs only. They must never be persisted or used as distinct active-pool keys.

## 3. Canonical topic registry (optional metadata)

Each label below has one stable machine ID across all its historical/optional metadata memberships. A label is not made into several topics merely because it is present in several Grade/Difficulty cells. These memberships must not gate upload, approval, publication, game routing, or result verification.

| `topic_id` | Canonical display label | Explicit aliases | Historic Fixed Question evidence policy (retired) |
| --- | --- | --- | --- |
| `basic_addition` | Basic Addition | none | deterministic evidence supported |
| `subtraction` | Subtraction | none | deterministic evidence supported |
| `shapes` | Shapes | none | explicit per-question `topic_id` required |
| `place_value` | Place Value | none | explicit per-question `topic_id` required |
| `addition` | Addition | none | explicit per-question `topic_id` required |
| `multiplication` | Multiplication | none | explicit per-question `topic_id` required |
| `word_problems` | Word Problems | none | explicit per-question `topic_id` required |
| `problem_solving_addition_subtraction` | Problem Solving (Addition and Subtraction) | none | explicit per-question `topic_id` required |
| `ordinal_numbers` | Ordinal Numbers | none | explicit per-question `topic_id` required |
| `basic_addition_subtraction` | Basic Addition/Subtraction | none | explicit per-question `topic_id` required |
| `division` | Division | none | explicit per-question `topic_id` required |
| `problem_solving` | Problem Solving | none | explicit per-question `topic_id` required |
| `fractions` | Fractions | none | explicit per-question `topic_id` required |
| `addition_of_money` | Addition of Money | none | explicit per-question `topic_id` required |
| `whole_numbers` | Whole Numbers | none | explicit per-question `topic_id` required |
| `multi_step_problem_solving` | Multi-step Problem Solving | `Multi-Step Problem Solving` | explicit per-question `topic_id` required |
| `number_theory` | Number Theory | none | explicit per-question `topic_id` required |
| `place_value_of_whole_numbers` | Place Value of Whole Numbers | none | explicit per-question `topic_id` required |
| `reading_writing_comparing_whole_numbers` | Reading, Writing, and Comparing Whole Numbers | none | explicit per-question `topic_id` required |
| `basic_arithmetic` | Basic Arithmetic | none | explicit per-question `topic_id` required |
| `time_conversion` | Time Conversion | none | explicit per-question `topic_id` required |
| `order_of_operations` | Order of Operations | none | explicit per-question `topic_id` required |
| `number_sense_and_operations` | Number Sense and Operations | none | explicit per-question `topic_id` required |
| `rational_numbers` | Rational Numbers | none | explicit per-question `topic_id` required |
| `geometric_measurements` | Geometric Measurements | none | explicit per-question `topic_id` required |

The table intentionally contains no semantic aliases such as `Addition` -> `Basic Addition`, `Problem Solving` -> `Problem Solving (Addition and Subtraction)`, or `Shapes` -> `Geometric Measurements`. Those labels name different canonical topics. No normalization can infer a topic from a similar-looking title or filename.

## 4. Approved membership matrix

Each semicolon-separated entry in a matrix cell is a separate selectable and publishable scope. Each individual composite label stays one canonical topic.

| Grade | Difficulty | Valid topics (`topic_id` — display label) |
| --- | --- | --- |
| Grade 1 | Easy | `basic_addition` — Basic Addition; `subtraction` — Subtraction; `shapes` — Shapes; `place_value` — Place Value |
| Grade 1 | Normal | `addition` — Addition; `multiplication` — Multiplication; `word_problems` — Word Problems |
| Grade 1 | Difficult | `problem_solving_addition_subtraction` — Problem Solving (Addition and Subtraction) |
| Grade 2 | Easy | `shapes` — Shapes; `ordinal_numbers` — Ordinal Numbers; `basic_addition_subtraction` — Basic Addition/Subtraction |
| Grade 2 | Normal | `multiplication` — Multiplication; `division` — Division; `word_problems` — Word Problems |
| Grade 2 | Difficult | `problem_solving` — Problem Solving; `multiplication` — Multiplication; `division` — Division; `fractions` — Fractions |
| Grade 3 | Easy | `addition_of_money` — Addition of Money; `whole_numbers` — Whole Numbers |
| Grade 3 | Normal | `multiplication` — Multiplication; `division` — Division; `fractions` — Fractions |
| Grade 3 | Difficult | `multi_step_problem_solving` — Multi-step Problem Solving |
| Grade 4 | Easy | `number_theory` — Number Theory |
| Grade 4 | Normal | `place_value_of_whole_numbers` — Place Value of Whole Numbers |
| Grade 4 | Difficult | `reading_writing_comparing_whole_numbers` — Reading, Writing, and Comparing Whole Numbers |
| Grade 5 | Easy | `number_theory` — Number Theory; `basic_arithmetic` — Basic Arithmetic |
| Grade 5 | Normal | `number_theory` — Number Theory; `basic_arithmetic` — Basic Arithmetic |
| Grade 5 | Difficult | `time_conversion` — Time Conversion; `number_theory` — Number Theory; `word_problems` — Word Problems; `order_of_operations` — Order of Operations |
| Grade 6 | Easy | `number_sense_and_operations` — Number Sense and Operations |
| Grade 6 | Normal | `number_sense_and_operations` — Number Sense and Operations |
| Grade 6 | Difficult | `rational_numbers` — Rational Numbers; `geometric_measurements` — Geometric Measurements |

### Composite-label rule

The following (and every other individual label in the registry) remain single canonical topics:

- `basic_addition_subtraction` — Basic Addition/Subtraction;
- `problem_solving_addition_subtraction` — Problem Solving (Addition and Subtraction);
- `number_sense_and_operations` — Number Sense and Operations; and
- `geometric_measurements` — Geometric Measurements.

They must not be decomposed, re-routed, or treated as aliases for other topics. Conversely, the semicolon-delimited values in the matrix do not form a composite.

## 5. Read-only registry endpoint contract

The planned public, read-only endpoint is:

```http
GET /api/curriculum/registry
Accept: application/json
```

It returns a static, versioned snapshot without accounts, uploaded content, answers, generated questions, or other tenant data. The frontend consumes this endpoint and derives its cascading selectors from `scopes`; it does not ship an independently authoritative `gradeTopicMap.js`.

```json
{
  "version": "2026-08-31",
  "grades": [
    { "value": "Grade 1", "display_label": "Grade 1", "aliases": ["1", "grade1"] }
  ],
  "difficulties": [
    { "value": "Easy", "display_label": "Easy", "aliases": [] },
    { "value": "Normal", "display_label": "Normal", "aliases": ["Medium", "Average"] },
    { "value": "Difficult", "display_label": "Difficult", "aliases": ["Hard"] }
  ],
  "topics": [
    {
      "topic_id": "basic_addition",
      "display_label": "Basic Addition",
      "aliases": [],
      "fixed_question_evidence": "deterministic"
    }
  ],
  "scopes": [
    {
      "grade_level": "Grade 1",
      "difficulty": "Easy",
      "topic_id": "basic_addition"
    }
  ]
}
```

Response fields are presentation and validation data, not permission to create or publish content. The endpoint must be cacheable by `version`/ETag and must never accept a write method.

Backend request adapters normalize Grade/Difficulty aliases at the boundary and resolve a legacy topic display label only through this exact registry and exact Grade/Difficulty membership. New API requests and all new persistence use `topic_id`. The temporary `topic`/`math_topic` display-label adapter is compatibility-only and rejects an unknown, ambiguous, out-of-membership, or missing value.

## 6. Fixed Questions: evidence and publication

The teacher-selected canonical Grade/Difficulty/Topic is the target publication scope. It is not evidence that every uploaded question belongs there.

1. `basic_addition` and `subtraction` retain their existing approved deterministic arithmetic evidence rules.
2. Every other topic requires an explicit, parsed per-question `topic_id` equal to the selected canonical `topic_id`.
3. Missing, malformed, unsupported, or non-matching question metadata is a truthful publication blocker. It does not silently become a different topic, a split set, or an auto-repaired value.
4. The document may still be structurally valid and reviewable where existing policy permits; topic evidence is a separate fail-closed publication gate.
5. OpenAI is not a publication-time classifier. Filename text, document title, prompt wording, a single keyword, and weak content heuristics are not topic evidence.

This includes composites. For example, `basic_addition_subtraction` is valid only when each question has explicit metadata for that exact composite topic until a separately approved deterministic rule exists. Individual addition or subtraction detection cannot be used to decompose or re-route it.

Recommended stable codes are `QUESTION_TOPIC_METADATA_REQUIRED`, `QUESTION_TOPIC_METADATA_UNSUPPORTED`, and `QUESTION_TOPIC_MISMATCH`, with the affected question number. Existing deterministic mismatch/unverified codes remain meaningful for the two approved deterministic topics.

## 7. AI-generated child question sets

An AI-generated child set is not treated as an unlabelled Fixed Question upload. A human already selected one valid registry scope before generation.

- The request stores the normalized Grade, Difficulty, and canonical `topic_id` on the child set.
- The backend derives the display label from the registry for the prompt and UI; it does not trust a client-supplied label as a second authority.
- Every generated child question inherits that stored canonical `topic_id`.
- Generated output receives structural validation (question count, choices, answers, parsing, and other existing safe checks), plus exact registry-membership validation.
- It is not reclassified through keyword, title, filename, or weak deterministic topic guessing.

One reusable Lesson source can therefore create independent children for separate approved tuples, even where its instructional text covers several ideas. Publishing one child cannot alter another child or another scope.

## 8. Legacy compatibility and future schema migration proposal

### Current legacy rows

Legacy Grade, Difficulty, display-topic, document, question, approval, publication, and history values remain readable and historically intact. No automatic rewrite, mass backfill, re-approval, re-publication, or topic guessing is authorized.

At read/validation time only, a legacy row may be *safely resolved in memory* when its normalized Grade, normalized Difficulty, and exact stored display label identify exactly one registry topic that is a valid membership. That bridge does not mutate the row. A missing topic, `math`, an unrecognized label, an out-of-matrix value, or any ambiguity stays unresolved and blocks publication.

The old display field remains a compatibility/readability field during the transition. For newly written data its value, when retained, is derived from the canonical registry label for `topic_id`, never independently submitted or interpreted.

### Future additive migration — proposal only

After final registry and migration-plan review, introduce a new, additive migration (following existing migration sequencing; not created or applied by this task) to add nullable `topic_id` columns to the question-set and per-question persistence records that participate in exact-scope selection and validation.

The intended shape is conceptually:

```sql
ALTER TABLE learning_files ADD COLUMN topic_id TEXT NULL;
ALTER TABLE questions ADD COLUMN topic_id TEXT NULL;
CREATE INDEX idx_learning_files_scope_topic_id
  ON learning_files (grade_level, difficulty, topic_id);
CREATE INDEX idx_questions_topic_id ON questions (topic_id);
```

The exact table/column names must be reconciled with the implemented schema before review; the SQL above is a migration proposal, not a migration file. `topic_id` must remain nullable at first so legacy history remains representable and prior application versions tolerate the additive columns.

Backfill is a separate approval-gated operation, not part of the schema migration. Its proposed process is:

1. snapshot and audit candidate rows without writing;
2. classify only exact, unambiguous tuple-and-display mappings using this registry;
3. produce a review report that lists every unresolved row and proposed non-destructive update;
4. obtain explicit review approval; and only then
5. apply narrowly scoped, reversible-by-forward-fix updates with row counts and post-update verification.

No guessed mapping, automatic composite decomposition, or content-text classifier is permitted in that backfill. Rows not safe to map keep `NULL` and remain ineligible for new publication until corrected through an authorized human workflow.

## 9. Frontend migration

The frontend replaces the independent `src/config/gradeTopicMap.js` ownership model with a small read-only registry client and selector adapters:

1. load `/api/curriculum/registry` once for the lesson/fixed-question workflow;
2. render Grades from `grades`;
3. render the three canonical difficulties for the selected Grade only when scopes exist;
4. render Topics from `scopes` matching the selected Grade/Difficulty, displaying registry labels while submitting `topic_id`;
5. use server-returned labels and validation errors for previews and summaries; and
6. remove the duplicate static map only after every consumer is migrated and the parity regression proves no residual owner remains.

The UI may cache a fetched immutable response for its session, but cache data is a copy of the backend registry, not a maintained curriculum map. A registry loading/error state must fail closed for creation/publication actions rather than present stale invented choices.

## 10. Godot compatibility

Godot does not fetch `/api/curriculum/registry` at runtime and retains no independent complete curriculum map. It uses only explicitly approved encounter literals and sends their canonical tuple to the game endpoint.

The only currently approved encounter scope is:

```gdscript
{ "grade_level": "Grade 1", "difficulty": "Easy", "topic_id": "basic_addition" }
```

If the existing Godot request contract requires a display label during the transition, it must be derived as `Basic Addition` for that single explicit scope—not reimplemented as a global topic registry. Godot's local difficulty boundary normalizer accepts `Medium`/`Average` as `Normal` and `Hard` as `Difficult`, then emits only `Easy`, `Normal`, or `Difficult`.

No new topic is assigned to City, Pinehill, or any other encounter by this decision. Encounters without an explicitly approved canonical topic remain unresolved; they must not request a widened or guessed topic pool.

Existing exact-scope randomization/history remains keyed by the canonical effective tuple and question set. This design does not change the stabilized QuestionProvider behavior.

## 11. Regression matrix for the future implementation

| Area | Required regression evidence |
| --- | --- |
| Registry data | exactly 6 Grades, exactly 3 Difficulties, all 25 topic IDs, all 18 matrix memberships, no duplicate IDs or invalid memberships |
| Normalization | `1`/`grade1` -> `Grade 1`; `Medium`/`Average` -> `Normal`; `Hard` -> `Difficult`; aliases do not form new pool keys |
| API | `GET /api/curriculum/registry` is read-only, versioned, and exactly reflects backend registry; no question/content data leaks |
| Backend validation | canonical `topic_id` must exist and be a valid Grade/Difficulty membership; legacy exact-label bridge is allowed only when safe; unresolved input fails closed |
| Fixed Questions | addition/subtraction deterministic pass/mismatch/unverified cases; every other topic rejects missing, unsupported, and mismatched per-question `topic_id` for publication |
| Composite topics | composite metadata is accepted only for that composite ID; individual arithmetic evidence cannot split or re-route it |
| AI children | selected normalized tuple is stored/inherited; structural validation runs; no weak topic reclassification runs |
| Legacy data | old values remain unchanged/readable; safe in-memory resolution works; unknown/ambiguous legacy rows cannot publish |
| Frontend | selector choices equal endpoint scopes; submitted payload uses `topic_id`; loading/error state blocks unsafe actions; no independent map remains |
| Game API | canonical `topic_id` resolves one exact active pool; legacy request aliases normalize only at the boundary; incomplete/invalid/unresolved scope is rejected |
| Godot | First Bandit emits `Grade 1` / `Easy` / `basic_addition`; local legacy difficulty values normalize; no registry runtime fetch and no unapproved encounter topic |
| Non-regression | approval/publish separation, source/child isolation, exact-set replacement, question history, authorization, preview behavior, and existing game behavior retain their current tests |

## 12. Explicit non-goals of this documentation change

- No backend, frontend, Godot, schema, test, or runtime source behavior is changed here.
- No migration is created, applied, or backfilled, including pending migration `015_add_lesson_source_lineage.sql`.
- No question is uploaded, approved, published, reclassified, altered, or moved between pools.
- No OpenAI call, deployment, push, APK build, or production read/write is performed.

The implementation sequence, exact files, and test-first checkpoints are in [the backend-owned registry implementation plan](superpowers/plans/2026-08-31-backend-owned-canonical-curriculum-registry.md). The existing exact-scope design and plan are amended to adopt this contract rather than their former duplicate-map approach.
