# Lesson Manager question source of truth

## Authoritative path

Teacher-managed question content follows one persisted path:

```text
Teacher upload or approved lesson generation
  -> backend document parsing/generation
  -> PostgreSQL learning_files + questions
  -> Teacher/Admin review and explicit Push to Game
  -> one Active question set per Grade + Difficulty + Topic scope
  -> GET /api/game/questions
  -> Godot QuestionProvider remote questions
```

`learning_files` is the question-set record. `questions.learning_file_id` is
the authoritative relationship between each parsed/generated question and its
set. Lifecycle is stored with the managed content: `published` and
`publish_status` identify the Active or superseded set, while the existing
generation fields identify lesson-review state. Set replacement is historical:
the former active set becomes superseded rather than being deleted.

The authenticated Lesson Manager list and question-preview endpoints read this
same data. Preview is read-only: it does not call `/api/game/questions`, change
`last_fetched_at`, publish content, or update questions.

## Fixed questions and AI-generated lessons

Fixed-question documents are stored by the backend upload flow and represented
as `learning_files` rows with parsed `questions` rows. Lesson PDFs are stored
by that same backend flow; their generated question sets are likewise stored in
the database and labeled `AI Generated` by the lifecycle response. Source type
is database metadata, not a Godot project folder.

PPTX is intentionally deferred. The current Teacher file picker, MIME/signature
allow-list, parser, validation tests, and security review cover the supported
fixed-question DOCX/PDF/JSON/CSV inputs and Lesson PDF flow only. This change
does not add a PPTX parser, dependency, or upload claim.

## Godot boundary and local files

Teacher uploads never write to `res://` in the Godot project. In the current
client, `QuestionProvider` requests the deployed backend first and uses the
returned active database questions when available. `res://Data/questions.json`
remains a bundled fallback for a legitimate remote failure or unusable remote
content; it is not the source of a normal Active set.

The repository's top-level `Questions/` development files have no active
runtime references in the current QuestionProvider path. They are legacy or
development artifacts, not production publication data. They are preserved:
deleting, restoring, or changing a local development copy must not be treated
as a production question-set operation. A local fallback file must not be
removed without a separately approved fallback migration and client test plan.

## Difficulty compatibility

New user-facing controlled labels are `Easy`, `Normal`, and `Difficult`.
Existing stored and client compatibility values normalize as follows:

| Stored/request value | Canonical display and matching scope |
| --- | --- |
| `Easy` | `Easy` |
| `Medium`, `Normal`, or legacy `Average` | `Normal` |
| `Hard` or `Difficult` | `Difficult` |

This normalization is applied at the backend matching and response boundary,
so `Medium`/`Normal` and `Hard`/`Difficult` cannot form distinct publication
scopes. It does not rewrite historical database rows and requires no migration
in this release. Godot's current legacy request terminology remains compatible
with the server and does not require a gameplay-code change in this scope.
