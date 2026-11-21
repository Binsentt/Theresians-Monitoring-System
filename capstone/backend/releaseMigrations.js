const crypto = require('node:crypto');

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

function migrationChecksum(sql) {
  const canonicalSql = sql.replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(canonicalSql, 'utf8').digest('hex');
}

function buildReleaseDatabaseConfig(env = process.env) {
  if (env.DATABASE_URL) {
    return {
      connectionString: env.DATABASE_URL,
      ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }

  const host = env.PGHOST;
  const user = env.PGUSER;
  const database = env.PGDATABASE;
  if (!host || !user || !database) return null;

  return {
    host,
    port: Number(env.PGPORT) || 5432,
    user,
    password: env.PGPASSWORD || '',
    database,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
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
  RELEASE_MIGRATIONS,
  buildReleaseDatabaseConfig,
  migrationChecksum,
  runReleaseMigrations,
};
