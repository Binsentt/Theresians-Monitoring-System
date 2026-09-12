const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_MIGRATIONS = Object.freeze([
  { version: 18, file: '018_website_sessions_and_audit_metadata.sql' },
  { version: 19, file: '019_playtime_history_removal.sql' },
  { version: 20, file: '020_add_auth_otp_challenge_security.sql' },
  { version: 21, file: '021_canonical_milestones_and_activity_contract.sql' },
]);

const ADVISORY_LOCK_KEY = 4819020;
const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version INTEGER PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

function readMigration(migrationDir, migration) {
  const filePath = path.resolve(migrationDir, migration.file);
  const expectedDir = path.resolve(migrationDir);
  if (!filePath.startsWith(`${expectedDir}${path.sep}`)) {
    throw new Error(`migration path escapes migration directory: ${migration.file}`);
  }
  return fs.readFileSync(filePath, 'utf8');
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

async function runReleaseMigrations({
  connectionString = process.env.DATABASE_URL,
  migrationDir = path.join(__dirname, 'migrations'),
} = {}) {
  if (process.env.RELEASE_MIGRATIONS_APPROVED !== 'true') {
    throw new Error('set RELEASE_MIGRATIONS_APPROVED=true for an authorized release migration run');
  }
  if (!connectionString) throw new Error('DATABASE_URL is required for release migrations');
  const { Client } = require('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await applyReleaseMigrations({ client, migrationDir });
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runReleaseMigrations()
    .then(() => console.log('Release migrations applied: 018, 019, 020, 021'))
    .catch((error) => {
      console.error(`Release migrations failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  ADVISORY_LOCK_KEY,
  RELEASE_MIGRATIONS,
  applyReleaseMigrations,
  migrationChecksum,
  runReleaseMigrations,
};
