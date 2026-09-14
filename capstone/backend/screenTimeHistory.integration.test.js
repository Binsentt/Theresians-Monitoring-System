const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const databaseUrl = process.env.SCREEN_TIME_TEST_DATABASE_URL || '';

if (!databaseUrl) {
  test('Screen Time history local PostgreSQL integration (set SCREEN_TIME_TEST_DATABASE_URL to run)', {
    skip: 'isolated local PostgreSQL URL not provided',
  }, () => {});
} else {
  assert.match(databaseUrl, /^postgres(?:ql)?:\/\/[^/]+\/tq_screen_time_test_[a-z0-9_]+$/i,
    'integration DB must be an isolated tq_screen_time_test_* database');
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
             (2, 'Local Active Student', 'screen-time-active@example.test', 'unused', 'student', 'active', false, 0)`);
    await pool.query(`INSERT INTO public.playtime_sessions
      (id, student_id, parent_id, student_name, status, start_time, end_time, total_playtime_minutes, total_playtime_seconds, date_played, expires_at, last_heartbeat_at)
      VALUES (11, 2, '900001', 'Local Active Student', 'Completed', NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '10 minutes', 30, 1800, CURRENT_DATE, NULL, NULL),
             (12, 2, '900001', 'Local Active Student', 'Playing', NOW() - INTERVAL '2 minutes', NULL, 2, 120, CURRENT_DATE, NOW() + INTERVAL '10 minutes', NOW())`);
    appServer = await new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  });

  test.after(async () => {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    await pool.end();
  });

  test('summary and bulk deletion agree, preserve active sessions, audit, and rollback stale targets', async () => {
    const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    const headers = { Authorization: `Bearer ${makeToken(1, 'admin')}` };
    const summary = await requestJson(`${baseUrl}/api/playtime/deletion-summary`, { headers });

    assert.equal(summary.status, 200);
    assert.equal(summary.body.visible_count, 2);
    assert.equal(summary.body.eligible_count, 1);
    assert.equal(summary.body.affected_count, 1);
    assert.equal(summary.body.preserved_count, 1);
    assert.deepEqual(summary.body.target_ids, [11]);

    const deleted = await requestJson(`${baseUrl}/api/playtime/completed/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reason: 'Remove ended local screen-time history',
        confirmation: 'DELETE',
        expected_count: summary.body.affected_count,
        target_ids: summary.body.target_ids,
        target_fingerprint: summary.body.target_fingerprint,
      }),
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted_count, 1);

    const rows = await pool.query('SELECT id, deleted_at FROM public.playtime_sessions ORDER BY id');
    assert.equal(rows.rows.length, 2);
    assert.ok(rows.rows.find((row) => row.id === 11).deleted_at);
    assert.equal(rows.rows.find((row) => row.id === 12).deleted_at, null);

    const audits = await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM public.admin_audit_logs
      WHERE operation_type = 'playtime_history_bulk_remove'`);
    assert.equal(audits.rows[0].count, 1);

    const zeroSummary = await requestJson(`${baseUrl}/api/playtime/deletion-summary`, { headers });
    assert.equal(zeroSummary.body.eligible_count, 0);
    assert.equal(zeroSummary.body.preserved_count, 1);
    const blocked = await requestJson(`${baseUrl}/api/playtime/completed/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reason: 'Should not mutate active session',
        confirmation: 'DELETE',
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
}
