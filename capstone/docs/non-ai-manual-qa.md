# Non-AI Manual QA Runbook

Status: local QA ready; release remains blocked pending owner approval for the new website commit.

## Scope and safety

This runbook is for the isolated local QA environment only. It uses synthetic accounts and a disposable PostgreSQL database. It must not be pointed at Railway production, a restored production backup, or a real student/parent account. No OpenAI request is made while `AI_GENERATION_ENABLED=false`.

The tested local revision is `ee16e9694a8583001c67f058bd056db3b47e974b`. The deployed Railway revision remains the previously observed `cdaa88993723bf10b61236bf95da6eeafc480863`; this local work is not deployed by Codex.

## Start and stop

From `C:\Users\vince\Documents\Capstone-Project\Theresian's Quest- Web\capstone`:

```powershell
$env:DATABASE_URL='postgresql://postgres@127.0.0.1:55443/theresians_nonai_qa'
$env:PORT='8081'
$env:AI_GENERATION_ENABLED='false'
$env:OPENAI_API_KEY=''
node backend/server.js
```

Open `http://127.0.0.1:8081/login` after the server reports readiness. Stop only the disposable process and cluster when the QA session is complete:

```powershell
Stop-Process -Id <local-qa-server-pid> -Force
pg_ctl -D C:\Users\vince\AppData\Local\Temp\theresians-nonai-qa-db stop -m fast
```

Do not commit passwords, OTPs, tokens, or production identifiers. Create synthetic Admin, Parent, Parent/Teacher, Teacher, and Student fixtures through the existing Admin account-creation service/API; do not insert relationships directly.

## Manual checklist

1. Sign in as the synthetic Admin and confirm the sidebar keeps `Manage Users`, then `ID Directory`, then `Lesson & Question Manager`.
2. Open Manage Users. Confirm normal list/search/individual actions remain available and the single pagination footer appears below the table's horizontal-scroll wrapper. It remains visible for loaded zero-, one-, and multi-page datasets, with truthful ranges and disabled controls when no adjacent page exists.
3. Open ID Directory. Confirm Students and Teachers tabs, authoritative account rows, filters, and the single pagination footer below each table's horizontal-scroll wrapper. A newly created synthetic Student must appear after reopening/refocusing the page, including an orphan Student; do not hide it to make the list look clean.
4. Open Lesson & Question Manager. Confirm the persistent banner exactly says: `AI generation is temporarily paused. Recorded data and available questions remain accessible.`
5. In the paused state, upload a disposable supported lesson source through the existing fixed/manual workflow. The source may be saved for review, but no provider call, generated question set, empty approval, or fabricated question content may appear. The row should read `Source Ready` / `Not Generated` (or the equivalent paused labels).
6. Open an existing genuine cached insight, if the fixture has one. It remains visible with an accurate current/stale timestamp and paused status; the retry control is not offered as a way around the pause. With no evidence, deterministic metrics remain available and the state is not presented as a fabricated AI recommendation.
7. Confirm non-AI operations remain usable: account navigation, directory search, fixed question browsing, saved source review, analytics metrics, and existing Parent/Teacher monitoring permissions.

## Automated evidence

The local verification used Node `v24.13.0` (Node 20 was not installed). Focused and full suites use mocked providers or the paused runtime; they are not a live-provider PASS. The two migration suites remain environment-gated when their dedicated test database variables are absent.

## Known human/device dependency

Godot and device gameplay are outside this website task. No Godot files were changed or run. A human must separately recheck the canonical game/device integration before any release is approved.
