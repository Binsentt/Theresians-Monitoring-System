# Final Question Review and AI Lesson Ingestion Design

**Status:** Approved product direction, audited specification, and implementation-planning input only. This document authorizes no runtime change, migration, deployment, question publication, OpenAI call, Godot change, APK action, or production write.

## Purpose

The Lesson Manager has two separate workflows with one shared, human-review lifecycle:

```text
Fixed Questions: source document -> parsed question records -> Preview -> review complete -> Approve -> Push to Game
Lesson / AI:     PDF or PPTX source -> clean lesson text -> AI child set -> Preview -> review complete -> Approve -> Push to Game
```

Fixed Questions preserve teacher-provided question content. Lesson sources provide instructional material from which the backend creates a new question set. Neither workflow may silently become the other.

## Audit baseline

This audit was performed against the deployed source commit `9dd9b7bd62f76fc6a1975cb3bf9d5120ebf66b8c`. It is read-only; no production data or content was inspected or changed.

### Fixed Questions today

| Concern | Current behavior | Decision / gap |
| --- | --- | --- |
| Source formats | DOCX and PDF are verified by MIME, file signature, and unambiguous extension. JSON/CSV remain backend compatibility formats. | Retain DOCX/PDF as the teacher-facing Fixed Question formats; do not advertise legacy `.ppt` or use filenames for scope. |
| Parser | `backend/fixedQuestionDocument.js` extracts DOCX through Mammoth and PDF through `pdf-parse`, preserves question order, trims/collapses whitespace, maps `Answer: B` to that option value, and validates the parsed fields. | This is safe formatting/mapping, not semantic rewriting. Add an explicit source-to-preview fidelity regression. |
| Structural validation | Existing checks cover readable numbered records, nonempty question, exactly four nonempty distinct choices, and one answer matching exactly one choice. | Keep and expose every card's exact reason; a malformed source is corrected outside the app and re-uploaded. |
| Exact scope | Upload already requires a backend-canonical Grade/Difficulty/Topic and persists `learning_files.topic_id`. | The selected canonical tuple becomes the declared Fixed Question set scope. Parsed question rows inherit it as set membership; that does not rewrite question text or classify content. |
| Topic gate | `questionScopeAssessment.utils.js` blocks `basic_addition`/`subtraction` when evidence is unverified, and blocks every other topic unless every parsed question includes `topic_id`. `document_topic` is also required; comma/and/semicolon-looking headings can yield `MULTI_TOPIC_DOCUMENT`. | This conflicts with the final declared-scope workflow. Remove metadata and document-heading requirements as publication gates. Keep only proved deterministic conflicts. |
| Preview / approval | Preview shows stored records in an inner scroll body and starts at the top. Approve is enabled immediately after structural eligibility. There are no per-question checkboxes. | Preserve no-checkbox behavior, add an actual last-question visibility gate, and reset it for every Preview session/content snapshot. |
| Publish | The server recomputes validation and current approval fingerprint in a transaction, then activates exactly one `grade_level + difficulty + topic_id` pool. The UI already displays eligibility messages. | Preserve exact-scope replacement, randomization, and no automatic publication; make the final blocker consistently explicit. |

### Lesson / AI today

| Concern | Current behavior | Decision / gap |
| --- | --- | --- |
| Reusable source | A `learning_files` row with `content_role = lesson_source` is linked to separate child question-set rows through `source_learning_file_id`. | Preserve the reusable source and independent child lifecycle. |
| Lesson formats | Upload accepts only PDF with MIME and `%PDF-` signature validation. | PDF: **supported**. PPTX: **not supported**. Legacy PPT: **not supported**. |
| Text extraction | `pdf-parse` produces text just before the backend Calls `generateLessonQuestions`. Empty PDFs are rejected. | Keep secure PDF behavior, but route both formats through one clean-text boundary before any provider request. |
| Prompt | `lessonQuestionGeneration.js` sends server-side Responses API input with Grade, Difficulty, `topic_id`, display label, count, title, and lesson text; it uses a 30-second abort and no retry. | Keep server-only credentials, idempotency, timeout, safe errors, and exact scope. Do not let title substitute for empty lesson text or silently truncate lesson text. |
| Generated output | JSON-schema output is parsed into question/options/correct answer; malformed or wrong-count output is rejected. The child rows are then stamped with selected Grade/Difficulty/Topic ID. | Keep canonical scope inheritance and structural validation. Do not weakly reclassify AI questions or auto-publish them. |

## Final contracts

### 1. Fixed Question source fidelity

The uploaded Fixed Question file is the source of truth for the question text, four choices, and correct answer. The parser may normalize line endings, whitespace, recognized choice labels, and answer labels only. It must not change wording, replace a choice, infer a new answer, generate a question, correct a mistake, or split one upload into scopes.

The persisted preview records are the parsed representation of the source. Their order is insertion/source order. Every review card shows the parsed question, choices A-D, mapped correct answer, and `Valid` or each exact structural error. The upload response may show the same failure cards without saving a malformed set.

Invalid Fixed Question content has one correction path: edit the source outside the application and upload a new/corrected file. There is no in-app question-content editor or automatic repair operation.

### 2. Fixed Question validation and scope

The exact selected scope is authoritative:

```text
grade_level: canonical Grade 1 ... Grade 6
difficulty:  Easy | Normal | Difficult
topic_id:    canonical registry ID valid for that Grade/Difficulty
```

The server validates this canonical tuple before reading or persisting the candidate set. It stamps the set and its persisted question rows with that tuple as declared set membership. This preserves canonical `topic_id` without requiring a teacher to embed hidden metadata in an ordinary document.

Structural validation must pass all of the following:

1. one supported source format and a valid matching signature/MIME;
2. at least one readable, well-formed question record;
3. nonempty question text;
4. exactly four nonempty, distinct choices;
5. exactly one correct answer mapped to one of those choices; and
6. a valid selected Grade/Difficulty/Topic registry scope.

`document_topic`, an optional parsed document heading, remains readable audit/display information only. It is not a second publication scope. `MULTI_TOPIC_DOCUMENT`, `MISSING_DOCUMENT_TOPIC`, and `DOCUMENT_TOPIC_MISMATCH` are retired as Fixed Question publication gates. A composite canonical label remains one topic; no source header is split on punctuation or conjunctions.

#### Deterministic conflict detection

The selected topic is the declaration for all topics without a proven content classifier. Missing, malformed, or absent optional per-question `topic_id` is not a blocker for ordinary Fixed Question documents.

`basic_addition` and `subtraction` retain the approved deterministic arithmetic evidence boundary. It may report a conflict only when one unambiguous, exclusive rule identifies the other arithmetic topic. For example, selected `basic_addition` plus `8 - 3 = ?` yields:

```text
Question N conflicts with selected Topic: Basic Addition.
```

No evidence, ambiguous wording, or a keyword-only guess is a conflict. It simply leaves the selected scope in force. The validator never reassigns a question, changes source content, or creates a second topic set. This replaces the prior fail-closed `QUESTION_TOPIC_UNVERIFIED` rule for ordinary Fixed Question uploads.

### 3. Complete human review gate

`review_complete` is intentionally UI-session state, not database evidence and not a replacement for server authorization. The server remains authoritative for role/scope, `review_required` status, structural eligibility, fingerprints, and approval writes. The client prevents the normal Approve action until the reviewer has viewed the final question.

On each Preview open, the inner modal question container is placed at Question 1 and `review_complete` starts false. A sentinel attached to the final question is observed with `IntersectionObserver` using that inner scroll container as `root`. When the final question becomes visible, the current session becomes complete. This also works for small sets whose last question is already visible after rendering; it never requires meaningless scrolling.

The state resets to false when Preview closes, opens, selects another set, starts loading a new set, or receives a different review fingerprint/content snapshot. It is never persisted and no checklist is restored.

Approve is enabled only when all are true:

```text
authorized Lesson Manager role/scope
approval_status === review_required
server-supplied structural review eligibility === eligible
final question is visible in this Preview session
no approval request is in flight
```

After success, the client uses the endpoint response, updates the open Preview, refreshes the list state, shows `Approved`, and recomputes publication eligibility. Approval does not publish.

### 4. Publication contract

For either workflow, eligibility is exactly:

```text
valid canonical selected scope
+ all question records structurally valid
+ no proved deterministic Fixed Question conflict
+ current server approval
=> eligible to Push to Game
```

If Push is unavailable, the UI and endpoint return the first exact actionable blocker. The publish transaction revalidates the canonical scope and current approval fingerprint, keeps the confirmed same-scope replacement behavior, and publishes the exact approved set to `Grade/Difficulty/topic_id`. Godot continues to request that existing exact scope; this work changes neither Godot nor randomization, unused-before-repeat behavior, retries, or exhaustion behavior.

### 5. Lesson text ingestion

Lesson sources are teaching material, not pre-authored questions. A source is non-publishable. Each generation chooses one canonical Grade/Difficulty/Topic and count, then creates an isolated child set with that inherited scope.

PDF and PPTX use one backend-only `extractLessonText` boundary before a generation child is made or OpenAI is called:

```text
validate upload -> extract readable text -> clean/validate text -> create/generate child -> structurally validate -> ready_for_review
```

The cleaner preserves Unicode and readable punctuation, converts control/formatting-only noise to safe whitespace, collapses whitespace, and reduces repeated blank lines. It does not summarize, OCR, translate, reorder, or send source-package bytes to the provider. Exceeding the configured safe text limit is a safe rejection before the provider request, rather than silent truncation.

Empty/unreadable PDF or PPTX text returns a safe message such as `No readable lesson text was found in this presentation.` The backend makes no provider call. Image-only presentations are handled this way; OCR is explicitly out of scope.

### 6. PPTX extraction design

PPTX support uses two explicit direct backend dependencies: `yauzl` for bounded read-only OOXML ZIP access and `fast-xml-parser` for non-executing XML parsing. A frontend/transitive `jszip` installation is not a backend contract and must not be relied upon.

Validation accepts only the standard PPTX MIME type, `.pptx` extension, ZIP signature, and required OOXML package members. It rejects extension/MIME/signature disagreement, ZIP traversal, missing presentation structure, and entry/expanded-size limits before text extraction.

Extraction reads only:

1. `ppt/presentation.xml` for ordered slide relationship IDs;
2. `ppt/_rels/presentation.xml.rels` to resolve each allowed slide target; and
3. each referenced `ppt/slides/slide*.xml` in presentation order.

From those slide XML parts it collects only rendered text-run content (`a:t`) in paragraph order, adding a visible `Slide N` boundary. It does not traverse relationships other than the presentation-to-slide list and never reads themes, layouts, masters, notes, media, animations, binary objects, or arbitrary package entries. Therefore XML markup, relationship IDs, shape IDs, theme/font tables, file paths, and control bytes cannot become model input.

`.ppt` remains unsupported. The UI calls Lesson sources `PDF or PPTX`, while legacy server errors name the real accepted type; no path claims `.ppt` support.

### 7. AI generation contract

The backend sends only clean readable lesson text plus the requested canonical Grade, Difficulty, `topic_id`, display label, and count. The provider receives no package internals, uploaded file path, frontend credentials, APK credentials, or source authorization token.

The schema output is converted to question records only. Before any questions are saved, the backend verifies the exact requested count, nonempty readable question text, exactly four distinct nonempty choices, exactly one mapped correct answer, and the inherited canonical scope. Invalid output produces a safe generation failure with no partial question-row save. The existing generation record may retain safe failed status and idempotency evidence, but it is never reviewable or publishable.

The child remains `ready_for_review`/`review_required` after valid generation. It goes through the same Preview, final-question visibility gate, approval, and explicit Push flow as Fixed Questions. There is no live battle provider call, automatic retry, weak post-generation keyword reclassification, or auto-publication.

### 8. Security and compatibility

All Lesson Manager routes retain backend `requireLessonQuestionManagerAccess` enforcement:

| Actor | Access |
| --- | --- |
| Admin | allowed |
| Teacher | allowed |
| Parent/Teacher, Teacher scope | allowed |
| Parent/Teacher, Parent scope | denied |
| Parent | denied |
| Student | denied |
| unauthenticated | denied |

OpenAI remains backend-only, uses the existing 30-second timeout and idempotency/deduplication behavior, and returns safe errors without raw provider text. The final APK, Godot, game routes, account lifecycle, Student Progress archive, Section registry, analytics, save/load, battle, and quest flow are out of scope.

## Data and migration decision

**Migration required: No.** Migrations 015/016 already provide the fields this design needs: source/child lineage, nullable canonical `topic_id` on sets and questions, source MIME/fingerprint support, approval state, and lifecycle state. `review_complete` is deliberately not persisted. Existing question insertion order provides the stable review order.

No legacy row is rewritten, backfilled, re-approved, re-published, or deleted. New Fixed Question writes use their selected canonical scope; existing legacy rows remain readable and keep the current safe resolution rules. This future implementation contains no schema migration.

## Acceptance matrix

### Fixed Questions

| Case | Required outcome |
| --- | --- |
| Source question/choices/answer | Parsed Preview values match source apart from safe whitespace/label normalization. |
| Three/five/duplicate/blank choices | Exact card error; no save/approve/push. |
| Missing or unmapped answer | Exact card error; no save/approve/push. |
| Selected canonical scope | Set and question rows retain Grade/Difficulty/`topic_id`. |
| Addition vs subtraction proof | Exact `Question N conflicts...` blocker; no reassignment. |
| Non-arithmetic/no proof | Selected scope remains valid; no metadata/keyword gate. |
| Multi-topic-looking header | Non-authoritative display text; no `MULTI_TOPIC_DOCUMENT` blocker. |
| Preview first open | Starts at Question 1; Approve disabled. |
| Last question visible | Approve becomes enabled only if structural/server eligibility also pass. |
| Close/reopen, file switch, content fingerprint change | Review gate resets. |
| Successful Approve | Response refreshes preview/list; no auto-publish. |
| Approved valid set | Push enabled unless the endpoint supplies another exact blocker. |

### Lesson / AI

| Case | Required outcome |
| --- | --- |
| Readable PDF | Clean readable text is supplied to backend generation. |
| Readable PPTX | Slide text appears in original slide order with `Slide N` boundaries. |
| XML/package junk | Absent from cleaned model input. |
| Empty/image-only PPTX | Safe error; zero provider calls. |
| Legacy `.ppt` | Safely rejected; never claimed supported. |
| Exact generation request | Prompt contains selected Grade, Difficulty, canonical ID, display label, and count. |
| Provider malformed/wrong count | Safe failure, no partial question rows, no publication. |
| Valid generated child | Inherits/persists selected scope and remains review-required. |
| Same reusable source, two scopes | Two isolated children with independent review/approval/publication. |
| Provider security | Backend-only key, 30-second timeout, no automatic retry, safe diagnostics. |

## Non-goals

- No runtime implementation in this documentation task.
- No OpenAI call, question upload, approval, publication, deployment, push, production read/write, or migration execution.
- No OCR, `.ppt` parser, content editor, source rewriting, topic splitting, or auto-correction.
- No Godot/API battle contract changes and no APK build/distribution.
