const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const RELEASE_MIGRATIONS = Object.freeze([
  { version: 18, file: '018_website_sessions_and_audit_metadata.sql' },
  { version: 19, file: '019_playtime_history_removal.sql' },
  { version: 20, file: '020_add_auth_otp_challenge_security.sql' },
  { version: 21, file: '021_canonical_milestones_and_activity_contract.sql' },
  { version: 22, file: '022_game_telemetry_contract.sql' },
  { version: 23, file: '023_quest_evidence_and_playtime_tombstones.sql' },
  { version: 24, file: '024_remove_legacy_six_digit_students.sql' },
  { version: 25, file: '025_add_game_result_question_traceability.sql' },
  { version: 26, file: '026_game_progress_save_commit_idempotency.sql' },
]);

const ADVISORY_LOCK_KEY = 4819020;
const PRODUCTION_RELEASE_CA_SHA256 = '9A84D18ED0BB44450D38DA6F35A3C4E22AD68192A0C91A2C96DD16E5C17C04DF';
const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version INTEGER PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

function assertTlsVerificationEnvironment(env = process.env) {
  if (String(env?.NODE_TLS_REJECT_UNAUTHORIZED ?? '') === '0'
      || String(process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '') === '0') {
    throw new Error('Node TLS certificate verification is disabled by NODE_TLS_REJECT_UNAUTHORIZED');
  }
}

function readMigration(migrationDir, migration) {
  const filePath = path.resolve(migrationDir, migration.file);
  const expectedDir = path.resolve(migrationDir);
  if (!filePath.startsWith(`${expectedDir}${path.sep}`)) {
    throw new Error(`migration path escapes migration directory: ${migration.file}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function createVerifiedPgTlsOptions(caPem, {
  expectedFingerprint = PRODUCTION_RELEASE_CA_SHA256,
  servername = 'localhost',
} = {}) {
  if (servername !== 'localhost') throw new Error('release TLS server name must be localhost');
  const expected = String(expectedFingerprint).replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(expected)) throw new Error('release CA fingerprint pin is invalid');

  const pem = Buffer.isBuffer(caPem) ? caPem.toString('utf8') : String(caPem ?? '');
  if (!pem || pem.includes('\uFFFD') || pem.startsWith('\uFEFF')) {
    throw new Error('release CA trust file is not valid UTF-8 PEM');
  }
  const match = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\r?\n?$/.exec(pem);
  if (!match) throw new Error('release CA trust file must contain exactly one PEM certificate');
  const base64 = match[1].replace(/\r?\n/g, '');
  const der = Buffer.from(base64, 'base64');
  if (!base64 || base64.length % 4 !== 0 || der.toString('base64') !== base64) {
    throw new Error('release CA trust certificate has malformed Base64');
  }

  let certificate;
  try {
    certificate = new crypto.X509Certificate(der);
  } catch (_error) {
    throw new Error('release CA trust certificate is not valid X.509');
  }
  const now = Date.now();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!certificate.ca || certificate.subject !== certificate.issuer
      || !Number.isFinite(validFrom) || !Number.isFinite(validTo)
      || now < validFrom || now > validTo
      || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)) {
    throw new Error('release CA trust certificate is not a currently valid self-signed CA');
  }
  const actual = certificate.fingerprint256.replace(/:/g, '').toUpperCase();
  if (actual !== expected) throw new Error('release CA trust certificate fingerprint does not match the approved pin');

  return {
    ca: certificate.toString(),
    rejectUnauthorized: true,
    servername: 'localhost',
  };
}

function buildReleaseDatabaseConfig(env = process.env, { password = env.PGPASSWORD } = {}) {
  assertTlsVerificationEnvironment(env);
  if (Object.prototype.hasOwnProperty.call(env, 'DATABASE_URL')) {
    throw new Error('DATABASE_URL is prohibited for controlled release operations');
  }
  const sslOverrideNames = ['PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGSSLNEGOTIATION'];
  if (sslOverrideNames.some((name) => Object.prototype.hasOwnProperty.call(env, name))) {
    throw new Error('PostgreSQL SSL override environment variables are prohibited');
  }
  if (env.DB_SSL !== undefined && env.DB_SSL !== 'true') {
    throw new Error('controlled release operations require verified TLS');
  }

  const host = String(env.PGHOST ?? '');
  const user = String(env.PGUSER ?? '');
  const database = String(env.PGDATABASE ?? '');
  const portText = String(env.PGPORT ?? '');
  if (host !== '127.0.0.1') throw new Error('controlled release operations require the explicit loopback tunnel host');
  if (!/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) {
    throw new Error('an explicit valid local tunnel port is required');
  }
  if (!user || !database || /[\0\r\n]/.test(user + database) || !password) {
    throw new Error('explicit PostgreSQL user, database, and authentication are required');
  }
  if (env.RELEASE_DB_TLS_SERVER_NAME !== 'localhost') {
    throw new Error('RELEASE_DB_TLS_SERVER_NAME must explicitly be localhost');
  }
  const caPath = String(env.RELEASE_DB_CA_FILE ?? '');
  if (!caPath) throw new Error('RELEASE_DB_CA_FILE must identify the verified pinned CA trust file');
  let caPem;
  try {
    const stats = fs.lstatSync(caPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > 64 * 1024) {
      throw new Error('not a small regular file');
    }
    caPem = fs.readFileSync(caPath);
  } catch (_error) {
    throw new Error('the configured release CA trust file is unavailable or unsafe');
  }
  const ssl = createVerifiedPgTlsOptions(caPem);
  if (net.isIP(host) !== 4) throw new Error('controlled release tunnel host must be IPv4 loopback');

  return {
    host,
    port: Number(portText),
    user,
    password: String(password),
    database,
    connectionTimeoutMillis: 5000,
    ssl,
  };
}

async function applyReleaseMigrations({
  client,
  migrationDir = path.join(__dirname, 'migrations'),
  migrations = RELEASE_MIGRATIONS,
}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('a PostgreSQL client is required');
  await client.query("SET statement_timeout = '15000ms'");
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await client.query(MIGRATION_TABLE_SQL);
    const existing = await client.query(
      'SELECT version, checksum FROM public.schema_migrations WHERE version = ANY($1::integer[])',
      [migrations.map(({ version }) => version)],
    );
    const applied = new Map(existing.rows.map((row) => [Number(row.version), String(row.checksum)]));

    for (const migration of migrations) {
      const sql = readMigration(migrationDir, migration);
      const checksum = migrationChecksum(sql);
      const previousChecksum = applied.get(migration.version);
      if (previousChecksum) {
        if (previousChecksum !== checksum) {
          throw new Error(`migration ${migration.version} checksum mismatch`);
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        `INSERT INTO public.schema_migrations (version, filename, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.file, checksum],
      );
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}

async function runReleaseMigrations(options = {}) {
  // Defer loading the gate until module exports are initialized when run directly.
  await Promise.resolve();
  const { runApprovedReleaseMigrations } = require('./scripts/run-approved-release-migrations');
  return runApprovedReleaseMigrations(options);
}

if (require.main === module) {
  runReleaseMigrations()
    .then(() => console.log('Release migrations applied: 018, 019, 020, 021, 022, 023, 024, 025, 026'))
    .catch((error) => {
      console.error(`Release migrations failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  ADVISORY_LOCK_KEY,
  assertTlsVerificationEnvironment,
  PRODUCTION_RELEASE_CA_SHA256,
  RELEASE_MIGRATIONS,
  applyReleaseMigrations,
  buildReleaseDatabaseConfig,
  createVerifiedPgTlsOptions,
  migrationChecksum,
  runReleaseMigrations,
};
