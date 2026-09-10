const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WEBSITE_SESSION_ABSOLUTE_TTL_MS,
  WEBSITE_SESSION_FRESHNESS_MS,
  buildOnlinePresenceSnapshot,
  createWebsiteSession,
  hashSessionCredential,
  resolveWebsiteSession,
  revokeWebsiteSession,
  touchWebsiteSession,
} = require('./websiteSession.service');

const fixedNow = new Date('2026-09-10T00:00:00.000Z');

test('creates a durable session while persisting only a credential hash', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ id: 41, created_at: fixedNow, last_seen_at: fixedNow, expires_at: params[3] }] };
    },
  };

  const session = await createWebsiteSession(client, { accountId: 7, now: fixedNow });

  assert.match(session.credential, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 7);
  assert.equal(calls[0].params[1], hashSessionCredential(session.credential));
  assert.notEqual(calls[0].params[1], session.credential);
  assert.equal(calls[0].params[3].toISOString(), new Date(fixedNow.getTime() + WEBSITE_SESSION_ABSOLUTE_TTL_MS).toISOString());
});

test('resolves active sessions but rejects revoked and absolutely expired credentials', async () => {
  const activeClient = {
    query: async () => ({ rows: [{ id: 9, account_id: 7, revoked_at: null, expires_at: new Date(fixedNow.getTime() + 1000) }] }),
  };
  assert.equal((await resolveWebsiteSession(activeClient, { accountId: 7, credential: 'secret', now: fixedNow })).ok, true);

  const revokedClient = {
    query: async () => ({ rows: [{ id: 9, account_id: 7, revoked_at: fixedNow, expires_at: new Date(fixedNow.getTime() + 1000) }] }),
  };
  assert.equal((await resolveWebsiteSession(revokedClient, { accountId: 7, credential: 'secret', now: fixedNow })).reason, 'revoked');

  const expiredClient = {
    query: async () => ({ rows: [{ id: 9, account_id: 7, revoked_at: null, expires_at: fixedNow }] }),
  };
  assert.equal((await resolveWebsiteSession(expiredClient, { accountId: 7, credential: 'secret', now: fixedNow })).reason, 'expired');
});

test('heartbeat and logout target only the current hashed session credential', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ id: 2, account_id: 4, last_seen_at: fixedNow, expires_at: new Date(fixedNow.getTime() + 1000) }] };
    },
  };

  await touchWebsiteSession(client, { accountId: 4, credential: 'browser-one', now: fixedNow });
  await revokeWebsiteSession(client, { accountId: 4, credential: 'browser-one', now: fixedNow, reason: 'logout' });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.params[1]), [
    hashSessionCredential('browser-one'),
    hashSessionCredential('browser-one'),
  ]);
  assert.match(calls[0].sql, /last_seen_at/i);
  assert.match(calls[1].sql, /revoked_at/i);
});

test('presence counts distinct accounts, expires stale sessions, and scopes parent_teacher without inflating total', () => {
  const fresh = new Date(fixedNow.getTime() - WEBSITE_SESSION_FRESHNESS_MS + 1);
  const stale = new Date(fixedNow.getTime() - WEBSITE_SESSION_FRESHNESS_MS - 1);
  const future = new Date(fixedNow.getTime() + 60_000);
  const rows = [
    { account_id: 1, role: 'teacher', last_seen_at: fresh, expires_at: future, revoked_at: null },
    { account_id: 1, role: 'teacher', last_seen_at: fresh, expires_at: future, revoked_at: null },
    { account_id: 2, role: 'parent', last_seen_at: fresh, expires_at: future, revoked_at: null },
    { account_id: 3, role: 'parent_teacher', last_seen_at: fresh, expires_at: future, revoked_at: null },
    { account_id: 4, role: 'teacher', last_seen_at: stale, expires_at: future, revoked_at: null },
    { account_id: 5, role: 'teacher', last_seen_at: fresh, expires_at: fixedNow, revoked_at: null },
    { account_id: 6, role: 'teacher', last_seen_at: fresh, expires_at: future, revoked_at: fixedNow },
  ];

  assert.deepEqual(buildOnlinePresenceSnapshot(rows, fixedNow), {
    total: 3,
    admins: 0,
    teachers: 2,
    parents: 2,
    parentTeachers: 1,
  });
});

test('two browser sessions count once and current-session logout preserves the other browser until both are revoked', () => {
  const rows = [
    { account_id: 10, role: 'teacher', last_seen_at: fixedNow, expires_at: new Date(fixedNow.getTime() + 60_000), revoked_at: null },
    { account_id: 10, role: 'teacher', last_seen_at: fixedNow, expires_at: new Date(fixedNow.getTime() + 60_000), revoked_at: null },
  ];
  assert.equal(buildOnlinePresenceSnapshot([], fixedNow).total, 0);
  assert.deepEqual(buildOnlinePresenceSnapshot(rows, fixedNow), {
    total: 1,
    admins: 0,
    teachers: 1,
    parents: 0,
    parentTeachers: 0,
  });

  rows[0].revoked_at = fixedNow;
  assert.equal(buildOnlinePresenceSnapshot(rows, fixedNow).total, 1);
  rows[1].revoked_at = fixedNow;
  assert.equal(buildOnlinePresenceSnapshot(rows, fixedNow).total, 0);
});
