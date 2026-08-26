# Theresian's Quest — Final Defense Runbook

## Purpose and safety boundary

This runbook is the human-executed proof of the connected website, production backend, and Android game.  It is deliberately read-only except where a step explicitly asks an authorized human to upload, publish, play, save, or reset.  Do not expose Parent IDs, Student IDs, passwords, session credentials, API keys, or database records during the defense.

Use only the approved Parent/Child pair and the current signed Android APK.  Do not create a replacement account, fabricate a result, publish a set other than the named demo set, call OpenAI manually, or make direct database edits.

## Pre-defense checklist

- Before the human run, record the actual deployed website/backend commit and confirm Railway health at `https://theresiansquest.com`. Do not assume a historical local commit is deployed.
- Production library: 28 sets / 68 questions. One set is active; the remaining 27 are staged and unpublished.
- Before the human run, record the exact signed APK commit, artifact path, and SHA-256 checksum. Verify package ID `com.theresiansquest.game`, production endpoint `https://theresiansquest.com`, and ETC2/ASTC before installation; do not treat a historical APK checksum as proof for a later release candidate.
- The demonstrator has an Admin account, a Teacher/Admin Lesson Manager account, an authorized Parent account, and the already-approved linked child. Use each role only in its proper portal context.
- Begin with no browser tabs or game screens showing identifiers, credentials, API responses, or private data.

## 1. Upload and review Set A — authorized Teacher/Admin

1. Open Lesson & Question Manager and choose **Fixed Question File**.
2. Upload `grade1-easy-basic-addition-set-a.docx`.
3. Select **Grade 1**, **Easy**, and **Basic Addition**. Leave Question Count blank.
4. Confirm review/preview shows exactly five questions, each with four nonempty distinct choices and one mapped correct answer.
5. Confirm the new upload is **Pending/Staged** and unpublished. Do not publish until the presenter requests the controlled Set A activation.

Expected: the teacher-facing document pipeline parses a DOCX without OpenAI, applies controlled metadata, and blocks invalid four-choice content before publication.

## 2. Parent/Child production login — game tester

1. Install the signed APK on the prepared Android device and start **New Game**.
2. Enter the approved Parent ID and Student ID privately. Do not show them to the audience.
3. Verify the game validates the parent and canonical linked child online.
4. Verify canonical name and Grade are populated and are not editable. A missing Section is valid and must not be fabricated.
5. Start the game and confirm a server-issued playtime lease is accepted, the loading screen completes, and **Player House** opens.
6. Leave the game running long enough for one normal heartbeat. Do not begin a battle yet.

Expected: release traffic uses `https://theresiansquest.com`; invalid or unlinked IDs remain blocked; the client accepts `session_id`, session credential, and server-authoritative remaining time.

## 3. Controlled Set A publication and first Bandit fetch — Admin/Teacher, then game tester

1. With explicit presenter approval, use **Push to Game** for only the newly reviewed Set A.
2. Refresh Lesson & Question Manager and confirm Set A becomes **Active in Game**. Record its displayed set ID only in private test notes.
3. Keep all other pending/staged sets unpublished.
4. In the game, reach the first Bandit without changing Godot code or local question files.
5. Confirm the battle scope is **Grade 1 / Easy / Basic Addition** and the remote question fetch identifies the active Set A ID. Local bundled questions are fallback-only.

Expected: Easy maps to Oakleaf Village; Medium maps to City of Knowledge; Hard maps to Pinehill Village. Legacy Normal maps to Medium and Difficult maps to Hard.

## 4. One genuine answer, result, and save — game tester

1. Answer one actual remote Set A question through the normal battle UI.
2. Confirm the quiz grades the selected answer normally.
3. Save the game using the normal multi-save UI; do not delete a save as part of this proof.
4. End the playtime session through the normal client path.

Expected: the result includes the active question-set identifier and active playtime lease context; RemoteSync submits it normally; no hand-built HTTP payload is used.

## 5. Monitoring proof — each authorized portal

### Admin

- In Student Progress, open the selected student and confirm current-cycle values use the genuine result only.
- In Student Analytics, confirm deterministic totals, accuracy, topic, difficulty, score, quest/scene, and progress reflect the same stored data where available.
- In Screen Time Monitoring, confirm the completed session remains historical monitoring data.
- In Activity Log, confirm only safe audit text is visible.

### Teacher

- Confirm the student appears only if the teacher has an explicit Teacher/Student or Grade/Section authorization path.
- Confirm the same current-cycle progress is visible, with no broader student disclosure.

### Parent and Parent/Teacher parent context

- In Child Progress, select only the linked child and confirm the same current-cycle data appears.
- If the Parent/Teacher role is demonstrated, switch deliberately between parent and teacher contexts. The parent view must not merge teacher-scoped students.

Expected: all portals read the same canonical student and deterministic data; none uses a second student record or an independent formula.

## 6. Controlled Set B replacement — only after Set A proof

1. Upload and preview `grade1-easy-basic-addition-set-b.docx` using the same Fixed Question File metadata.
2. Confirm it is a different valid five-question set and remains Pending/Staged before approval.
3. With explicit presenter approval, Push only Set B to Game.
4. Confirm the same Grade 1 / Easy / Basic Addition first-Bandit scope now fetches Set B without a Godot code change.

Expected: same-scope activation replaces the active content authoritatively; no other question set is published.

## 7. Learning-cycle reset and old local save proof

1. From the authorized progress portal, use **Reset Progress** with the approved reason **New Lesson**. This starts a new learning-cycle version; it does not delete historical Screen Time or Activity Log records.
2. Refresh Admin, authorized Teacher, Parent, and Parent/Teacher views. Confirm current-cycle progress is fresh/no-progress truthfully and the canonical student remains visible.
3. On the same device, open Load Game. Confirm the old save is labeled **Previous Learning Cycle**, its **Load** action is disabled, and **Delete** remains available only as a manual local action.
4. Start a new game normally. Confirm the existing fresh New Game quest architecture is used; do not alter quest order, battle logic, or QuestionProvider.

Expected: server-side stale-cycle result/progress writes are rejected; website reset does not claim it physically deleted a device file.

## 8. Lifecycle policy explanation — no live destructive demo required

- **Reset Progress:** starts a new learning cycle for the same canonical student while preserving historical results, Screen Time, and Activity Log.
- **Reset All:** Admin only for all eligible active students; Teacher only for authorized scope; Parent forbidden; Parent/Teacher only in teacher context. It requires a reason, affected count, and typed confirmation.
- **Archive Progress:** removes a student from active progress views without starting a new lesson or restarting the game; use for graduation, end of year, transfer, no longer enrolled, or approved cleanup. Historical data remains available in Archived Progress.
- **Archive All:** bulk archive with the same authorization boundary; do not use New Lesson as an archive reason.
- **Permanent Gameplay Progress Delete:** Admin only. It removes gameplay/progress-derived rows and insight cache, advances the cycle, and writes a reasoned audit event. It preserves accounts, Parent/Student links, teacher assignments, Screen Time, Activity Log, lessons, question sets, questions, and publication history.

Do not execute Reset All, Archive All, Archive, or Permanent Delete against real records during the defense unless separately approved.

## 9. AI analytics and quota contingency

Deterministic metrics are always calculated from stored results. OpenAI may only interpret sanitized factual metrics after at least five valid per-question results. With fewer than five, the expected UI is **Not enough gameplay data yet to generate a reliable analysis.** Do not make an OpenAI call to demonstrate this state.

If the provider remains unavailable or returns the known quota condition, report that grounded AI insight is unavailable while deterministic progress, monitoring, authorization, and lifecycle functions remain unaffected. Do not switch providers or generate substitute content.

## 10. Expected success indicators

- Teacher DOCX upload is parsed, reviewed, and held Pending/Staged until an explicit Push to Game.
- The release client validates the Parent/Student pair online, accepts a real lease, and enters Player House.
- The first Bandit fetches only the active same-scope remote set and retains its question-set ID.
- A genuine answer flows to monitoring with deterministic current-cycle metrics and question-set traceability.
- Set B replaces Set A within the same scope with no Godot code change.
- A new learning cycle blocks stale local saves from loading but preserves manual delete and historical monitoring.
- Protected roles show only their authorized scope; no portal combines unrelated children or students.

## 11. Stop conditions

Stop and capture a sanitized error if any of the following occurs: invalid Parent/Student authorization, missing lease fields, blocked gameplay entry, a remote fetch falling back unexpectedly, a Set A/B validation failure, mismatched question-set traceability, unauthorized portal data, or a real script/runtime error. Do not work around a stop condition by fabricating a result, changing production data directly, or exposing secrets.
