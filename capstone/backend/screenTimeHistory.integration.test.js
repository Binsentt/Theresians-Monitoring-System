const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const databaseUrl = process.env.SCREEN_TIME_TEST_DATABASE_URL || '';

const isSafeDatabaseUrl = (value) => {
  try {
    const parsed = new URL(value);
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
      && /^tq_screen_time_test_[a-z0-9_]+$/i.test(databaseName);
  } catch {
    return false;
  }
};

if (!databaseUrl) {
  test('Screen Time history local PostgreSQL integration (set SCREEN_TIME_TEST_DATABASE_URL to run)', {
    skip: 'isolated local PostgreSQL URL not provided',
  }, () => {});
} else {
  assert.equal(isSafeDatabaseUrl(databaseUrl), true,
    'integration DB must be an isolated loopback tq_screen_time_test_* database');
  process.env.DATABASE_URL = databaseUrl;
  process.env.AI_RUNTIME_ENABLED = 'false';

  let app;
  let schemaReady;
  let pool;
  let appServer;

  const runMigration = async () => {
    const migrationSql = fs.readFileSync(path.join(__dirname, 'migrations', '019_playtime_history_removal.sql'), 'utf8');
    for (const statement of migrationSql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await pool.query(`${statement};`);
    }
  };

  const makeToken = (userId, role) => jwt.sign(
    { userId, role, sessionVersion: 0 },
    process.env.JWT_SECRET || 'change-this-in-production',
    { expiresIn: '10m' },
  );

  const requestJson = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    return { status: response.status, body: await response.json() };
  };

  test.before(async () => {
    const bootstrapPool = new Pool({ connectionString: databaseUrl });
    await bootstrapPool.query(`CREATE TABLE IF NOT EXISTS public.accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      password TEXT,
      role VARCHAR(50) NOT NULL,
      status VARCHAR(50) DEFAULT 'active'
    )`);
    await bootstrapPool.query("ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'");
    await bootstrapPool.end();
    ({ app, schemaReady } = require('./server'));
    pool = require('./database/db');
    await schemaReady;
    await runMigration();
    await runMigration();
    await pool.query('TRUNCATE public.admin_audit_logs, public.playtime_sessions, public.accounts RESTART IDENTITY CASCADE');
    await pool.query(`INSERT INTO public.accounts (id, name, email, password, role, status, is_archived, session_version)
      VALUES (1, 'Local Screen Time Admin', 'screen-time-admin@example.test', 'unused', 'admin', 'active', false, 0),
             (2, 'Local Completed Student', 'screen-time-completed@example.test', 'unused', 'student', 'active', false, 0),
             (3, 'Local Active Student', 'screen-time-active@example.test', 'unused', 'student', 'active', false, 0)`);
    await pool.query(`INSERT INTO public.playtime_sessions
      (id, student_id, parent_id, student_name, status, start_time, end_time, total_playtime_minutes, total_playtime_seconds, date_played, expires_at, last_heartbeat_at)
      VALUES (11, 2, '900001', 'Local Completed Student', 'Completed', NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '10 minutes', 30, 1800, CURRENT_DATE, NULL, NULL),
             (12, 3, '900001', 'Local Active Student', 'Playing', NOW() - INTERVAL '2 minutes', NULL, 2, 120, CURRENT_DATE, NOW() + INTERVAL '10 minutes', NOW())`);
    appServer = await new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  });

  test.after(async () => {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    await pool.end();
  });

  test('archive summary and bulk archive agree, preserve active sessions, expose archived history, and audit', async () => {
    const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    const headers = { Authorization: `Bearer ${makeToken(1, 'admin')}` };
    const summary = await requestJson(`${baseUrl}/api/playtime/deletion-summary`, { headers });

    assert.equal(summary.status, 200);
    assert.equal(summary.body.visible_count, 2);
    assert.equal(summary.body.eligible_count, 1);
    assert.equal(summary.body.affected_count, 1);
    assert.equal(summary.body.preserved_count, 1);
    assert.deepEqual(summary.body.target_ids, [11]);

    const archived = await requestJson(`${baseUrl}/api/playtime/completed/bulk/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reason: 'Archive ended local screen-time history',
        confirmation: 'ARCHIVE',
        expected_count: summary.body.affected_count,
        target_ids: summary.body.target_ids,
        target_fingerprint: summary.body.target_fingerprint,
      }),
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.archived_count, 1);

    const rows = await pool.query('SELECT id, deleted_at FROM public.playtime_sessions ORDER BY id');
    assert.equal(rows.rows.length, 2);
    assert.ok(rows.rows.find((row) => row.id === 11).deleted_at);
    assert.equal(rows.rows.find((row) => row.id === 12).deleted_at, null);

    const audits = await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM public.admin_audit_logs
      WHERE operation_type = 'playtime_history_bulk_archive'`);
    assert.equal(audits.rows[0].count, 1);

    const archivedHistory = await requestJson(`${baseUrl}/api/playtime?lifecycle=archived`, { headers });
    assert.equal(archivedHistory.status, 200);
    assert.deepEqual(archivedHistory.body.data.map((row) => row.id), [11]);
    assert.equal(archivedHistory.body.data[0].total_playtime_minutes, 30);

    const zeroSummary = await requestJson(`${baseUrl}/api/playtime/deletion-summary`, { headers });
    assert.equal(zeroSummary.body.eligible_count, 0);
    assert.equal(zeroSummary.body.preserved_count, 1);
    const blocked = await requestJson(`${baseUrl}/api/playtime/completed/bulk/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reason: 'Should not mutate active session',
        confirmation: 'ARCHIVE',
        expected_count: 0,
        target_ids: [],
        target_fingerprint: zeroSummary.body.target_fingerprint,
      }),
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /no eligible completed screen time records/i);
    const active = await pool.query('SELECT deleted_at FROM public.playtime_sessions WHERE id = 12');
    assert.equal(active.rows[0].deleted_at, null);
  });

  test('single-record archive retains provenance, blocks active rows, and preserves canonical daily and total accounting', async () => {
    const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    const headers = { Authorization: `Bearer ${makeToken(1, 'admin')}` };
    const reason = 'Archive one completed local screen-time record';

    await pool.query(`INSERT INTO public.playtime_sessions
      (id, student_id, parent_id, student_name, status, start_time, end_time, total_playtime_minutes, total_playtime_seconds, date_played, expires_at, last_heartbeat_at)
      VALUES (13, 2, '900001', 'Local Completed Student', 'Completed', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '5 minutes', 15, 900, CURRENT_DATE, NULL, NULL)`);

    const readCanonicalAccounting = async () => {
      const daily = await requestJson(`${baseUrl}/api/playtime/today/2`, { headers });
      const progress = await requestJson(`${baseUrl}/api/students/progress`, { headers });
      assert.equal(daily.status, 200);
      assert.equal(progress.status, 200);
      const student = progress.body.find((row) => Number(row.student_id) === 2);
      assert.ok(student, 'completed Student remains available in canonical progress analytics');
      return {
        dailySeconds: Number(daily.body.total_playtime_seconds),
        dailyMinutes: Number(daily.body.total_playtime_today),
        totalSeconds: Number(student.metrics.playtimeSeconds),
        totalMinutes: Number(student.metrics.playtimeMinutes),
      };
    };

    const accountingBefore = await readCanonicalAccounting();
    assert.deepEqual(accountingBefore, {
      dailySeconds: 2700,
      dailyMinutes: 45,
      totalSeconds: 2700,
      totalMinutes: 45,
    });

    const archived = await requestJson(`${baseUrl}/api/playtime/13/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason, confirmation: 'ARCHIVE' }),
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.archived_record_id, 13);
    assert.match(archived.body.archive_operation_id, /^[0-9a-f-]{36}$/i);

    const archivedRow = await pool.query(`SELECT id, deleted_at, deleted_by, deletion_reason, deletion_operation_id
      FROM public.playtime_sessions WHERE id = 13`);
    assert.equal(archivedRow.rows.length, 1);
    assert.ok(archivedRow.rows[0].deleted_at);
    assert.equal(archivedRow.rows[0].deleted_by, 1);
    assert.equal(archivedRow.rows[0].deletion_reason, reason);
    assert.equal(archivedRow.rows[0].deletion_operation_id, archived.body.archive_operation_id);

    const blocked = await requestJson(`${baseUrl}/api/playtime/12/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Must not archive active local session', confirmation: 'ARCHIVE' }),
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /active screen time sessions cannot be archived/i);

    const activeRow = await pool.query(`SELECT status, deleted_at, deleted_by, deletion_reason, deletion_operation_id
      FROM public.playtime_sessions WHERE id = 12`);
    assert.equal(activeRow.rows.length, 1);
    assert.equal(activeRow.rows[0].status, 'Playing');
    assert.equal(activeRow.rows[0].deleted_at, null);
    assert.equal(activeRow.rows[0].deleted_by, null);
    assert.equal(activeRow.rows[0].deletion_reason, null);
    assert.equal(activeRow.rows[0].deletion_operation_id, null);

    const accountingAfter = await readCanonicalAccounting();
    assert.deepEqual(accountingAfter, accountingBefore,
      'archiving history must not alter canonical daily or total playtime accounting');

    const singleAudit = await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM public.admin_audit_logs
      WHERE operation_type = 'playtime_history_archive'
        AND target_account_id = 13`);
    assert.equal(singleAudit.rows[0].count, 1);
  });
}
