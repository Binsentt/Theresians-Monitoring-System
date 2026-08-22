# Server-Authoritative Daily Playtime Design

## Goal

Make the existing 60-minute daily playtime limit authoritative on the backend while preserving the Godot session contract and the website's database-backed Screen Time Monitoring.

## Server authority

The backend records the server-created start and expiry timestamps for each active playtime session. It calculates consumed duration and daily aggregation from database/server time only; client start/end timestamps and client duration are ignored. A bounded heartbeat returns fresh remaining seconds and closes expired sessions. End requests identify the linked parent/student/session and use server time capped at the recorded expiry.

## Compatibility

The start response remains compatible with `remaining_minutes`, `daily_limit_minutes`, `can_play`, and `session_id`, adding `remaining_seconds`, `expires_at`, and a session credential only when a session exists. Existing saved or completed rows remain readable. No website UI or production data is changed by the migration itself.

## Security

The game continues its established Parent ID plus Student ID identity contract. A cryptographically random per-session credential is stored only as a secure hash and is required for heartbeat/end session operations, preventing unrelated session-ID control. All relationship resolution remains server-side.

## Verification

Backend tests use controlled time and query stubs for: server timestamps, existing-session expiry, daily cap, heartbeat, end cap, invalid credential, parent/student mismatch, restart/resume, and no client-time trust. Migration tests verify additive columns/indexes. Godot integration tests use HTTP stubs only; production verification is read-only.
