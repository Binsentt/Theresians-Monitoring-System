# Grade Difficulty Topic Filter Design

## Scope

This Part 1 design standardizes Mathematics lesson and question metadata across Grades 1-6.
It changes the Lesson & Question Manager and the supporting backend validation and storage paths.
Announcement and parent-game pipeline work remain separate follow-up designs.

## Current Findings

- The frontend currently stores a grade-only topic map in `src/components/lessonQuestionManager.utils.js`.
- The backend currently stores a separate grade-only topic map in `backend/learningContentRules.utils.js`.
- Current topic validation only checks for a valid grade and a non-empty topic, so it accepts mismatched topics.
- `learning_files` and `questions` currently persist `grade_level` and `math_topic` but do not persist `difficulty`.
- Legacy records without difficulty must continue to load and display as unknown metadata.

## Data Contract

The stored difficulty values are exactly:

- `Easy`
- `Normal`
- `Difficult`

No other difficulty values are valid in UI state, API payloads, or database writes.
Grade 3 may display `Average Round` in UI copy for the `Normal` choice only; the stored value remains `Normal`.

The grade, difficulty, and topic mapping is hardcoded as a nested `GRADE_TOPIC_MAP` on both frontend and backend.
The supplied master map is the rule source for every allowed combination.

## Frontend Design

The Lesson & Question Manager upload and edit flows expose the metadata fields in this order:

1. Grade Level
2. Difficulty
3. Topic

The topic dropdown is disabled until both grade and difficulty are selected and shows
`Select grade and difficulty first`. Once both values exist, topic options come only from
`GRADE_TOPIC_MAP[grade][difficulty]`.

Changing grade or difficulty re-evaluates the selected topic. The form keeps a topic only
when it remains valid for the new combination; otherwise it selects the first allowed topic
for that combination or clears the value while prerequisites are missing.

The listing filters apply the same metadata sequence. Grade narrows matching records,
difficulty narrows those records again, and topic narrows to the mapped topic values.
Legacy rows with null difficulty stay visible unless a difficulty filter is active.

## Backend Design

Backend helpers own validation for:

- grade level
- difficulty
- topic allowed for the selected grade and difficulty

Learning-file uploads and question persistence reject invalid combinations with a clear
HTTP `400` response before writing metadata. Generated/imported question rows inherit the
validated grade, difficulty, and topic metadata from the learning file path that created them.

Legacy reads tolerate null difficulty. New writes from the Lesson & Question Manager require
a valid difficulty so newly saved lessons and questions are filterable by the full metadata set.

## Schema Design

Add nullable `difficulty` columns to `public.learning_files` and `public.questions`.
Nullable columns protect existing records that predate this metadata.

Indexes should match the query path used for listing and gameplay lookup:

- learning files: grade, difficulty, topic
- questions: grade, difficulty, topic

The existing schema initialization path and migration path should agree on these columns
and indexes so local and deployed databases converge.

## Error Handling

- Frontend blocks invalid topic selections by deriving options from the map.
- Backend remains authoritative and returns `400` for missing or invalid new metadata.
- Existing null-difficulty records do not crash list rendering, edit rendering, or filters.

## Testing

Add focused regression coverage for:

- the full grade/difficulty/topic map and exact difficulty values
- disabled topic selection before prerequisites exist
- topic reset when grade or difficulty changes
- metadata filters across grade, difficulty, and topic
- backend rejection of invalid combinations
- schema/persistence paths carrying difficulty into learning files and questions

Verification after implementation includes targeted frontend tests, backend unit tests,
the production frontend build, and backend JavaScript syntax checks.
