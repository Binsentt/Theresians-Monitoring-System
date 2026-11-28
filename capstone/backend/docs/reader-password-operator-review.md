# Reader password operator review candidate

Production remains NO-GO. This candidate requires review of the final commit,
compiled executable, native-library manifest and protected authorization record
before using the existing conditional production authorization. Development
and synthetic CI do not supply that approval.

## Execution boundary

The ordinary `VerifiedReaderPasswordWorker.cs` build still returns 30 before
connecting. A deliberately compiled `TQ_OPERATOR` build includes
`VerifiedReaderPasswordOperator.cs`. Its gate validates the entire protected
operation before invoking the same `PQchangePassword` core used by the Windows
PostgreSQL 18 integration. It cannot select another role or bootstrap an
administrator. Only the separately compiled `TQ_SYNTHETIC` test boundary permits
the disposable loopback fixture identities; never deploy that build.

The reviewed production supervisor is
`scripts/productionReaderPasswordOperator.cjs`. It checks its own and the
executable's approved digests before starting a one-session relay, rejects
ambient PostgreSQL overrides, and imposes a 60-second worker deadline, finite
termination/output collection and finite relay cleanup. It emits status flags
only. A timeout, nonzero exit, stderr, unexpected/incomplete output, contradictory
status, missing final completion or unverified cleanup stops the operation.
No retry is provided.

The C# gate requires:

- Clean source at the independently approved exact commit, with tracked and
  separately pinned worker, gate and supervisor bytes. Git filters, submodules,
  inherited Git overrides and source changes are rejected before execution.
- Exact approved administrator/reader profiles and passfiles under the existing
  protected recovery directory, plus the previously verified CA destination.
  The reader file is the existing password source; no interactive credential
  input, password generation or file replacement is performed.
- Exactly seven service settings: `host`, `hostaddr`, `port`, `dbname`, `user`,
  `sslmode`, `sslrootcert`. Production is fixed to localhost/IPv4 loopback,
  relay port 55432, database `railway`, administrator `postgres`, reader
  `tq_release_preflight_reader`, and `verify-full`. The root's exact approved
  DER fingerprint remains mandatory. The server address comes from the reviewed
  independent target record, never from the tested connection itself.
- Protected current-user/SYSTEM/Administrators FullControl DACLs, current-user
  ownership, no inherited rules, no reparse traversal and distinct regular
  credential files. Handles prevent input replacement while the worker runs;
  input hashes are independently rechecked after the callback.
- The approved executable hash and exact full native DLL manifest. DLL files
  remain locked during use. Safe Windows DLL search loads the absolute pinned
  `libpq.dll`; its actual loaded path and PostgreSQL 18 library version are
  verified. The executable directory cannot contain DLLs, local redirection or
  an executable configuration file. The approved Git binary is also pinned.
- A protected authorization record with a maximum one-hour UTC validity window,
  the exact role/operation, source, paths, hashes and independently supplied
  target address. An operation-wide lock excludes concurrent execution. A fixed
  `operation.consumed` CreateNew receipt survives every later failure and cannot
  be bypassed by changing the authorization identifier.

The receipt records `STATE=OUTCOME_UNKNOWN` durably **before** entering the
callback. `COMPLETED=0` is appended and flushed only after the callback succeeds
and all held input hashes remain unchanged. A missing completion, killed
process, unknown result or failed postcheck remains consumed and requires
read-only reconciliation plus separately applicable authorization; do not
delete the receipt or change journal directories to retry.

## Review and compilation procedure

1. Independently review the final immutable source and CI results. Keep the
   existing preflight source pin separate: it remains
   `57908cba66e39a187caa290b2bd1eb0a776f7d26`.
2. Verify the compiler provenance and compile the two C# sources with
   `/target:exe /define:TQ_OPERATOR` using the reviewed Windows compiler. Do not
   define `TQ_SYNTHETIC`. Place the resulting executable in a protected directory
   outside the checkout; compute and independently review its SHA-256.
3. Review a verified PostgreSQL 18 distribution and each DLL digest. Preserve
   the installed PostgreSQL tools; use a separate protected native-library
   directory and exact manifest rather than changing installed-tool permissions.
4. Create the authorization record in the existing protected preflight
   directory only after the owner reviews the bindings. Verify the current
   encrypted volume, exact parent ACLs, trusted target/proxy mapping, source,
   original administrator identity evidence and existing credential tuple.
   Do not copy record contents or private digests to public GitHub or chat.
5. Reconfirm that the earlier conditional authorization is unused and applies
   to this exact reviewed operator. Run only after the applicable operator
   review has passed. This document does not activate the authorization.

The record is strict ASCII `key=value`, one field per LF line, final LF,
without comments, blank/duplicate/unknown fields or a BOM. Required keys are:

```text
formatVersion operation operationId issuedUtc expiresUtc
sourceCommit repositoryRoot tunnelPort serverPort targetServerAddress
adminServiceFile adminServiceSha256 adminPassfile adminPassfileSha256
readerServiceFile readerServiceSha256 readerPassfile readerPassfileSha256
rootCaFile rootCaSha256 executableSha256 gateSourceSha256 workerSourceSha256
supervisorSourceSha256 gitExecutable gitSha256 nativeDirectory journalDirectory
native.<each-lowercase-dll-basename>
```

Use `formatVersion=1`, `operation=reader-password-sync`, a canonical GUID,
lowercase SHA-256/source digests, and UTC timestamps `yyyy-MM-ddTHH:mm:ssZ`.
The native entries must match every DLL in the approved directory, with no
extra/missing entry. The authorization file SHA-256 and expected source commit
are independent invocation inputs. Review and pin both; never learn either
from an unreviewed input at execution time.

After review, the invocation shape is:

```text
node productionReaderPasswordOperator.cjs --execute-reviewed-reader-sync <reviewed-executable> <protected-authorization-file> <independently-approved-authorization-sha256> <clean-reviewed-checkout> <approved-operator-source-commit> <previously-reviewed-relay-module>
```

This is an operator review contract, not a production copy-paste command.
The protected operator record supplies the real non-secret paths and pins;
credentials never appear in arguments. Review exact values locally.

## Subsequent preflight and recovery gates

Only a confirmed synchronization and verified cleanup permits the two reviewed
restricted-reader preflight sessions. Preserve the separate clean checkout at
the exact approved preflight commit. The first role audit establishes actual
reader authentication; do not insert another reader probe. Run the second
migration-026 prerequisite session only if the first passes. No administrator
fallback, SET ROLE or automatic retry is permitted.

The independent routine review, externally enforced writer/sequence freeze,
approved backup, isolated PostgreSQL 18 restore and migration rehearsal remain
mandatory before separately approved production migration/deployment. See the
[review handoff](production-recovery-review-handoff.md). The writer admission
candidate does not authorize a backup and does not remove the existing stop.
