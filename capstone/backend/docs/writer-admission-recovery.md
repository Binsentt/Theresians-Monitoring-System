# Writer admission and recovery candidate

Production backup and migration remain **NO_GO**. This work adds a read-only
assessment and a disposable PostgreSQL 16/18 admission/drain experiment. It does
not authorize a production freeze, session termination, backup, migration,
password change or deployment. No production database was accessed by this work.

## Design and scope

The existing `backupWriterQuiescence.integration.cjs` demonstrates that relation
locks do not freeze sequences. A session can consume cached `nextval` values, a
new session can allocate another cache, and `setval` changes sequence state while
the table/catalog lock barrier is held. Sequence state is outside ordinary MVCC
rollback. See PostgreSQL's [sequence function documentation](https://www.postgresql.org/docs/16/functions-sequence.html)
and [sequence cache behavior](https://www.postgresql.org/docs/18/sql-createsequence.html).

The candidate closes **all normal new admissions**, then waits for every target
database session except an exact preconnected allowlist to exit voluntarily.
It uses `ALTER DATABASE ... ALLOW_CONNECTIONS false` in a transaction committed
from a separate control database. PostgreSQL documents this flag in
[version 16](https://www.postgresql.org/docs/16/sql-alterdatabase.html) and
[version 18](https://www.postgresql.org/docs/18/sql-alterdatabase.html).

The allowlist contains `(pid, backend_start, login-role OID)`, rather than a role
name or `application_name`. A new session using the same role has no exception.
New ordinary connections by the database owner, superuser, an explicitly granted
writer, an inherited-role writer, a role with only PUBLIC CONNECT, and the backup
role are all rejected while the flag is false. PID reuse or a lost allowlisted
session invalidates readiness. Idle sessions remain blockers: they retain the
ability to write, call routines and use cached sequence values.

Other approaches were considered:

| Control | Useful property | Remaining gap |
| --- | --- | --- |
| Application maintenance flag / relation locks | Coordinates application traffic and blocks table writes | Other writer paths and sequence caches remain live. |
| Revoke CONNECT/CREATE/TEMP from PUBLIC and named roles | Can retain admissions for a backup identity | Effective inherited grants, grant options, owner/admin ability to regrant, existing sessions and exact ACL restoration require separate proof. |
| Committed `ALLOW_CONNECTIONS false`, selected here | Closes normal new admissions without rewriting any ACL, grantor, role, CREATE/TEMP privilege or ownership | Blocks a newly launched `pg_dump` too; existing sessions, background-worker bypass and privileged control-plane changes remain outside the guarantee. |

The result is an auditable **admission/drain state**, never a universal
quiescence certificate. `admissionDrained=true` always accompanies
`productionQuiescence=NO_GO` in the implementation.

## Assessment

`../scripts/writerAdmissionAssessment.sql` is a transaction explicitly declared
READ ONLY and ended with ROLLBACK. An already authorized evidence reader can run
it with `psql --no-psqlrc --set=ON_ERROR_STOP=1 --file=...` using the approved
connection mechanism. The script accepts no URL or credential and emits no
application rows, role names, routine bodies, queries or subscription connection
strings. It collects:

- Database admission flags; PUBLIC CONNECT/CREATE/TEMP; effective privileges
  across every LOGIN role, including inherited permissions and superusers;
  owner-membership and cluster privileged-role counts.
- Target sessions grouped by backend type/state; prepared transaction count;
  enabled subscriptions, foreign tables/servers, extensions, SECURITY DEFINER
  routines, triggers, event triggers and preload-library presence.

Review access must be sufficient to inspect those catalogs. Permission failure,
missing visibility, or an unknown writer path is a stop; zero counts are not
proof of external isolation. The SQL is evidence collection, not an instruction
to run another production action. Keep any resulting evidence in the restricted
review record.

## Transaction and recovery state

The executable `writerAdmissionControl.cjs` is **CI-only**. Its connection target
is fixed to `postgres` on IPv4 loopback port 5432. It accepts no target argument or
connection string, rejects ambient PostgreSQL environment settings, and verifies
the GitHub Actions context, exact source SHA, expected PG16/18 major, Docker data
directory and a current-run database comment sentinel before mutation. The
fixture database is separate from the existing writer-lock fixture. This module
is not a production operator CLI.

1. Preconnect the synthetic backup reader. Record its exact session identity.
   Keep a separate verified control connection in `postgres` for recovery.
2. In one transaction, take a cooperative advisory lock, capture the target OID,
   name, owner, ACL, connection limit, original admission flag and sentinel in a
   protected control-database journal, then change `ALLOW_CONNECTIONS` to false.
   The journal and flag commit together. An already-closed database is refused.
3. Observe every target session and every prepared transaction. Sample database
   object startup locks **before** sampling `pg_stat_activity`; an in-flight
   connection can pass the admission check before closure and finish startup
   afterwards, without yet appearing in the activity view. Any sampled lock
   holder absent from the later activity sample is a conservative drain blocker.
   The delayed-startup case exercises this with `post_auth_delay`. This ordering
   follows the [PG16 startup implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/utils/init/postinit.c)
   and [PG18 startup implementation](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/init/postinit.c)
   and must be revalidated when extending supported versions. Do not terminate
   sessions. Every nonallowlisted backend, including idle and worker backends,
   must exit; every prepared transaction must be explicitly resolved. There is
   no automatic commit/rollback of another session's work. A bounded observer
   timing out has no authority to kill blockers or reopen the gate.
4. Report a point-in-time drained admission state only when the same journal,
   target identity and false flag remain present, every allowlisted session is
   still present, no other target backend or unobserved startup remains and no
   prepared transaction exists. A read-only allowlisted session can still SELECT and hold ACCESS
   SHARE locks. No test result promotes this to production readiness.
5. Recovery uses another verified control connection and discovers the durable
   journal; it does not depend on an in-memory receipt or a target connection.
   Under the cooperative lock, check the target OID/name/sentinel, owner, ACL and
   connection limit before restoring the captured true admission flag and
   marking the journal restored in one transaction. Drift causes refusal and
   leaves admission closed for explicit review. There is no direct catalog
   update, blanket GRANT, password reset or role recreation.

An interruption **before COMMIT** rolls back the flag and journal. An interruption
**after COMMIT**, including loss of the COMMIT acknowledgement, leaves the target
closed and the journal discoverable. The controller must never silently reopen
on process exit: that could admit a reconnecting writer during a backup. Recovery
requires reviewed explicit action from a surviving control route. The synthetic
harness exercises recovery and deletes only objects it created, after validating
its run sentinel; it never uses `DROP DATABASE ... FORCE` or backend termination.

## Exact limitations and backup incompatibility

- The database owner or a superuser already connected to **another database**
  can change `ALLOW_CONNECTIONS` back to true. The harness demonstrates this
  bypass. Advisory locks coordinate these scripts; arbitrary administrators do
  not have to honor them. External isolation of all privileged routes and
  provider/control-plane operations is required and is not established here.
- PostgreSQL supports `BGWORKER_BYPASS_ALLOWCONN`. Such workers can connect even
  while ordinary connections are disabled. Existing or dynamically registered
  workers, subscriptions, extension schedulers, preload modules and external
  integrations require separate review and isolation. See official
  [PG16 background-worker documentation](https://www.postgresql.org/docs/16/bgworker.html)
  and [PG18 background-worker documentation](https://www.postgresql.org/docs/18/bgworker.html).
- Every preexisting session still has its prior rights until it exits. The
  harness proves CREATE, TEMP, cached `nextval`, SECURITY DEFINER routines and
  trigger-driven `setval` continue after admission closes. Allowlisted sessions
  are trusted participants and can still write if their privileges permit it.
  A SET-based read-only default is not an enforcement boundary for privileged
  identities. Functions and triggers must be reviewed for side effects.
- Draining all old writer sessions discards their private sequence caches. It
  does not make sequence changes transactional, protect another database, stop
  an external/foreign data source, or establish cluster-global consistency.
  Reopening before the capture completes invalidates the admission proof.
- **The current backup command cannot use this closed gate.** Standard
  [`pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html) opens its own
  connection; parallel dumps open additional connections. A preconnected Node
  or psql reader cannot be handed to standard `pg_dump`. An exported snapshot
  still requires the importing dump connection to connect, and it does not
  freeze non-MVCC sequence state. This candidate does not include a proven
  preconnected `pg_dump` handshake or a replacement capture engine. Reopening
  briefly so a dump can connect also admits reconnecting writers.

An eventual production path needs an independently reviewed admission mechanism
that preserves a backup connection route while excluding all writers, such as a
provider-enforced/HBA/network boundary with an isolated backup identity, together
with privileged/background-worker isolation and tested recovery. Its availability
on the managed service is unproven. Application pausing or a CONNECT-only revoke
does not supply that proof. Until that gap and the existing production gates are
closed, preserve the backup/migration hard stop.

## Implementation and validation record

The implementation plan is confined to these new files: unit tests for target
proof and exact-session accounting; the CI-only transactional controller; a real
disposable PG16/18 harness; the aggregate read-only SQL; and this design/recovery
record. No existing backup command is enabled or changed by these files.

Local verification on 2026-11-28 observed all six unit cases fail first because
the controller was absent, then pass after implementation. JavaScript syntax
checks passed, and launching the integration harness without CI proof refused
at `ci-target-validation` before loading `pg` or opening a socket. Docker,
PostgreSQL client/server binaries and WSL were unavailable locally; this is
**not a claim that the real database cases passed locally**.

A seventh unit case then reproduced the in-flight startup omission and failed
before startup-lock accounting was added; all seven now pass locally.

CI must run `node --test scripts/writerAdmissionControl.test.cjs` and
`node scripts/writerAdmission.integration.cjs` in the existing isolated test
setup for **both PG16 and PG18**. Start each disposable PostgreSQL server with
`-c max_prepared_transactions=10`. The integration command uses the same safety
environment and fixed-loopback network namespace as the existing relation-lock
harness, with the existing run-sentinel anchor database. It creates and removes
its own database, roles and control journal. Required real cases are:

- Read-only role/PUBLIC/routine/trigger assessment; explicit transaction rollback
  and controller disconnect before commit.
- Reconnect denial for explicit, PUBLIC, inherited, owner, superuser and backup
  roles; demonstrated owner reopening from another database; a delayed in-flight
  startup that is not yet in `pg_stat_activity` and can finish after closure.
- Existing-session cached sequence use, routine/trigger writes and CREATE/TEMP
  after closure; prepared transactions and natural session drain.
- Stable synthetic sequence reads after drain; controller interruption after
  commit, recovery from a fresh control connection and exact control restoration.
- Refusal on control drift, a missing allowlisted backup session and an
  originally disabled database; cleanup without terminating any session.

Passing these cases establishes the stated synthetic behaviors on those server
versions. It does not remove any production limitation above.
