# Question Library Ownership and Import Safety

## Two separate stores

### Bundled Godot question files

`res://Questions/` is content packaged with the Godot project and, after export,
with the installed game. It is useful as local/development fallback content. It
is not the same physical store as the website library, and changing a website
record never changes a file inside an already-exported APK.

### PostgreSQL-managed production question sets

`public.learning_files` and their `public.questions` rows are the production
question library shown in Lesson & Question Manager. These are the only sets
that authorized users can review, publish, replace, trash, or permanently
remove from the website. The production Godot API reads published PostgreSQL
questions; Godot uses bundled content only when that remote request fails or
returns no usable questions.

## Website lifecycle

The backend is authoritative for lifecycle state. Internal `staged` remains
compatible with existing data, while the user-facing label is **Pending**.

| Backend state | Website label | Meaning |
| --- | --- | --- |
| `generating` | Generating | Lesson extraction and generation are in progress. |
| `ready_for_review` + `staged` | Ready for Review | Generated questions are available for preview and are not published. |
| `staged` | Pending | Fixed or reviewed questions are waiting for Push to Game. |
| `active` | Active in Game | The API can return this set for its grade/difficulty/topic scope. |
| `superseded` | Replaced | A newer same-scope set was published. |
| `failed` | Failed | Generation did not create a valid staged set. |

Push to Game is a database transaction. It validates the selected set, marks
the prior active set for the same grade/difficulty/topic as `superseded`, marks
the new set `active`, records publication metadata, and returns the
authoritative row. The React screen then refetches it; it does not infer
“Active in Game” from a button click.

The public Godot question endpoint records `last_fetched_at` only after it has
actually returned active questions belonging to a set. The UI therefore
distinguishes:

- **Active in Game** — the backend will provide the set for that scope.
- **Last Game Fetch** — at least one game request received questions from it.
- **Answered by Student** — requires result records and is not inferred here.

Delete moves PostgreSQL-managed content to the existing trash model. An active
set, including one reached through a legacy folder delete route, is rejected
with HTTP 409 until a replacement is active. Permanent deletion affects only
the backend-managed record, its linked question rows, and its managed upload;
it never deletes bundled `res://Questions/` content.

## Client-provided bundle dry run

Run the read-only audit with:

```powershell
node scripts/audit-godot-question-bundle.js "<path-to-Godot-project>\Questions"
```

The command does not connect to PostgreSQL and cannot import, publish, modify,
or delete anything. It maps `Normal → Medium` and `Difficult → Hard` for
reporting only. Its current local-bundle scan found:

- 28 files discovered.
- Grade distribution: Grade 1 = 7; Grade 2–6 = 4 each; 1 unclassified flat
  legacy JSON file.
- Difficulty distribution: Easy = 8, Medium = 7, Hard = 7, unclassified = 6
  boss files without a difficulty folder.
- 74 parse-compatible question records, including 6 exact duplicate records.
- 13 malformed/unparseable question records across 13 files under the current
  strict parser.
- 7 files with incomplete grade/difficulty metadata.

The audit deliberately does not claim how many are already represented in
PostgreSQL, because this phase does not perform a production comparison. It
also performs **no production import**. Before any future import, run a fresh
read-only comparison against `learning_files`/`questions`, review every
malformed or metadata-incomplete record, generate a duplicate-safe manifest,
and obtain explicit approval for the resulting production row count.

## Future traceability

Game results do not yet retain a question-set/version identifier. The smallest
backward-compatible next enhancement is an additive `question_set_id` (and
optional version) field on result submissions, populated from the active API
response and nullable for historic rows. It should be designed separately; no
schema change is made by this work.
