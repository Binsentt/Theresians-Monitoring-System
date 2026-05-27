# Godot-to-Website Integration Plan

## Source of Truth

Railway backend data is the production source of truth for Godot and the website.
Godot must not depend on manually copied local files in production.

Question uploads are stored by the backend as staged learning files and parsed into
unpublished question rows. A file becomes usable by Godot only after a teacher clicks
Push to Game.

## Activity Logs

Godot posts activity/session updates to:

`POST /api/activity-logs`

Required payload:

```json
{
  "student_id": 44,
  "student_name": "Ava Santos",
  "grade": "Grade 3",
  "current_quest": "Fractions Gate",
  "timestamp": "2026-05-27T12:30:00.000Z",
  "duration_seconds": 420
}
```

Accepted aliases:

- `grade` or `grade_level`
- `timestamp`, `started_at`, or `last_played`
- `duration_seconds`, `total_play_time`, or a formatted `duration`

Website Activity Log displays only:

- Student Name
- Grade
- Time
- Activity
- Duration

Role scope:

- Admin sees all student activity.
- Teacher sees only assigned students when teacher scoping is present.
- Parent sees only linked children.
- Parent activity logs are filtered by the selected child. Logs for multiple children are never mixed in one table request.

## Fixed Question Structure

The visible game question structure is fixed:

```text
Questions/
  Grade1/
    Easy/
    Normal/
    Difficult/
  Grade2/
    Easy/
    Normal/
    Difficult/
  Grade3/
    Easy/
    Normal/
    Difficult/
  Grade4/
    Easy/
    Normal/
    Difficult/
  Grade5/
    Easy/
    Normal/
    Difficult/
  Grade6/
    Easy/
    Normal/
    Difficult/
```

The website does not create folders. The upload destination is derived from:

- selected grade
- selected difficulty
- selected topic identifier

Topic is an identifier/category, not a folder creator.

## Question Upload Flow

1. Teacher uploads a supported lesson/question file on the website.
2. Backend saves the file and parsed questions as staged/unpublished data.
3. The uploaded file appears in the Lesson & Question Manager table.
4. Teacher previews the file.
5. Teacher clicks Push to Game.
6. Backend marks that file and its parsed questions active.
7. Backend unpublishes the previous active file/questions for the same grade + difficulty + topic.
8. Godot fetches the latest active questions from `GET /api/game/questions`.

Upload does not push to game automatically.

## Godot Fetch Flow

Godot requests active questions from:

`GET /api/game/questions?grade_level=Grade%203&difficulty=Normal&math_topic=Fractions`

The response contains only pushed/active questions. Bandits and boss bandits should use this endpoint before starting the relevant encounter or when refreshing the encounter question pool.

## Railway Deployment Readiness

Railway must run the same backend schema initialization used locally so production has:

- `learning_files.published`
- `questions.published`
- `learning_files.difficulty`
- `questions.difficulty`
- activity log gameplay/session columns

The backend API remains the integration boundary for both website and Godot clients.
