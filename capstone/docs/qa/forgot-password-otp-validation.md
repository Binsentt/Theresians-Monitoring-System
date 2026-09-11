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

## Runtime notes

The canonical local machine currently runs Node.js v24.13.0 while `capstone/package.json` declares Node.js 20.x. The Railway service remains read-only inspected; no deployment or configuration change was made.
