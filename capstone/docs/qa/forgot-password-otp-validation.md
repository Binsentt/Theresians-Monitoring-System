# Forgot Password and OTP validation QA

This continuation hardens the existing website recovery and login OTP flows.

## Contract

- Recovery uses generic public wording and does not disclose whether an email is registered.
- Codes are six-digit text values, kept as strings so leading zeroes survive input and transport.
- Codes are generated with cryptographic randomness, stored as HMAC digests bound to a challenge id, and scoped by purpose (`recovery`, `login`, or `password_change`).
- The server enforces expiry, resend cooldown, maximum attempts, single-use consumption, and row locking for concurrent verification.
- Successful recovery increments the account session version, revokes website sessions, clears remembered-device OTP skips, and consumes the challenge in the same transaction as the password update.
- Password characters are not trimmed or normalized; the existing minimum eight-character policy remains authoritative.

## Verification evidence

The integration suite runs against a disposable local PostgreSQL database named with the `tq_auth_recovery_test_*` prefix. Email delivery is replaced only inside that test process with an in-memory capture; no SMTP/Resend request is made. The suite covers malformed and unknown email handling, leading-zero codes, cooldown, wrong/expired/replayed/purpose-mismatched codes, attempt limits, resend invalidation, concurrent/session-safe consumption, password policy and confirmation mismatch, and normal-login acceptance of the new password.

Frontend tests cover inline email/OTP/password feedback, accessibility attributes, one-time-code input semantics, and duplicate-submit protection.

Real external email delivery, production recovery, and production password changes were not performed.

## Self-contained QA rules

- Run from a clean checkout with `DATABASE_URL` and `AUTH_RECOVERY_TEST_DATABASE_URL` set to a disposable local database before importing the backend.
- Never fall back to a tracked `.env`, a production `DATABASE_URL`, or a real browser profile.
- Capture test mail only in-process; external recovery email count must remain zero.
- Keep browser auth state, OTPs, passwords, tokens, and screenshots outside Git and redact them from reports.

## Browser handoff

The local Chrome binary is installed, but the headless smoke in this session did not produce an inspectable DOM and authenticated interactive automation is not available in the configured Codex session. Owner QA must use a disposable local account and mail capture to verify the recovery form, generic unknown-email response, wrong/expired/reused OTP, resend invalidation and cooldown, password policy/mismatch, duplicate-submit behavior, successful login, and rejection of the old password/session.

## Runtime notes

The canonical local machine currently runs Node.js v24.13.0 while `capstone/package.json` declares Node.js 20.x. The Railway service remains read-only inspected; no deployment or configuration change was made.
