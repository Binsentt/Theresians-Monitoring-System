# Server-Authoritative Daily Playtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the daily 60-minute gameplay allowance with backend timestamps and a low-frequency lease revalidation endpoint.

**Architecture:** PostgreSQL stores server-derived session start/expiry and a hashed session credential. `server.js` calculates remaining time and expiry inside the active-session transaction. Godot receives server lease data, uses it for display/warnings, and sends a bounded heartbeat; the backend remains the source of truth.

**Tech Stack:** Node.js, Express, PostgreSQL, Node built-in tests, existing Godot `RemoteSync` HTTP client.

---

### Task 1: Add an additive playtime-session migration

**Files:**
- Create: `backend/migrations/007_add_playtime_session_authority.sql`
- Modify: `backend/server.schema.test.js`

- [x] Write a migration-content test expecting nullable server start, expiry, credential hash, and last-heartbeat columns plus indexes.
- [x] Add only additive columns and indexes; preserve existing session rows and read queries.
- [ ] Run final migration-content tests and `git diff --check`.

### Task 2: Extract server-time lease helpers

**Files:**
- Modify: `backend/server.js`
- Test: `backend/server.playtime.test.js`

- [x] Add a failing route test proving a start request ignores client timestamps and returns a bounded server lease.
- [x] Implement server-time duration, daily aggregate, expiry calculation, and a sanitized lease response.
- [x] Run focused tests and confirm New Game relationship registration remains compatible.

### Task 3: Secure session resume, heartbeat, and end

**Files:**
- Modify: `backend/server.js`
- Test: `backend/server.playtime.test.js`

- [x] Add tests for heartbeat refresh, lease expiry, missing/invalid credentials, and server-capped end time.
- [x] Add `/api/playtime/heartbeat`, require the session credential for heartbeat/end, and use server-side timestamps for all duration updates.
- [x] Ensure start finalizes an existing active session before deciding whether a new lease may start.
- [x] Run focused playtime, progress, parent-child, and game-result tests.

### Task 4: Preserve result/progress authority at expiry

**Files:**
- Modify: `backend/server.js`
- Test: `backend/server.playtime.test.js`

- [x] Add tests that a missing or expired session rejects new gameplay result writes while ordinary progress save remains compatible.
- [x] Require the same active playtime lease ID and credential on new Godot result writes; existing historical rows remain readable without altering them.
- [x] Run result-traceability and analytics input tests.

### Task 5: Verify and checkpoint

**Files:**
- Test: `backend/server.playtime.test.js`
- Test: `backend/server.gameProgress.test.js`
- Test: `backend/server.parentGameResults.test.js`

- [x] Run all backend suites and `git diff --check`.
- [ ] Commit only the server-playtime-authority branch after final Godot contract verification.
