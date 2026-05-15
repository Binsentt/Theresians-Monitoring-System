# AI & Analytics Deployment Notes

## What AI/model is used

This project does not currently call an external LLM or third-party AI model.

The "AI" features in this system are rule-based analytics generated on the backend in `backend/server.js` through:

- `generateStudentAnalysis(record)`
- `buildAIRecommendations(rows)`
- `buildGradeSummary(rows)`

These functions produce:

- recommendation text
- strengths and weaknesses insights
- difficulty breakdowns
- overall accuracy/progress summaries

## Where AI is integrated

Backend endpoints:

- `GET /api/analytics/overview`
- `GET /api/analytics/recommendations`
- `GET /api/students/progress-analysis`
- `GET /api/student-progress/:studentId`

Frontend integration points:

- `src/components/AdminStudentProgress.js`
- `src/components/TeacherStudentProgress.js`
- `src/components/StudentProgress.js`
- `src/components/ParentChildProgress.js`
- `src/components/ParentDashboard.js`
- `src/components/StudentAnalytics.js`

## Active AI/analytics features

- grade-level performance overview
- progress percentage tracking
- student difficulty breakdown
- strengths and weaknesses insights
- student recommendation insights
- dashboard recommendation panels
- student analytics detail view

## How recommendations and analytics are generated

Recommendations and analytics are derived from:

- `student_game_progress` records
- linked student account data from `accounts`
- calculated values such as:
  - accuracy rate
  - progress percentage
  - total/correct/incorrect answers
  - difficulty distribution
  - score trends

The backend computes the final recommendation/analytics payloads and the frontend renders them with fallback-safe handling when one analytics endpoint is temporarily unavailable.

## Deployment readiness notes

- Backend startup now safeguards the required analytics tables (`student_game_progress`, `activity_logs`) so fresh environments do not crash solely because those tables were never created.
- Core progress pages now handle analytics requests independently, so a failed recommendation request does not take down the full page.
- Recommendation panels fall back safely to empty-state messaging instead of crashing on undefined or null payloads.
- Student analytics and dashboard views continue rendering available progress data even when a non-critical analytics request fails.
