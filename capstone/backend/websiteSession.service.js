const crypto = require('node:crypto');

const WEBSITE_SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WEBSITE_SESSION_FRESHNESS_MS = 75 * 1000;
const WEBSITE_SESSION_HEARTBEAT_INTERVAL_MS = 25 * 1000;
const WEBSITE_SESSION_DASHBOARD_REFRESH_MS = 30 * 1000;

const toDate = (value) => {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const hashSessionCredential = (credential) => crypto
  .createHash('sha256')
  .update(String(credential || ''), 'utf8')
  .digest('hex');

const createSessionCredential = () => crypto.randomBytes(32).toString('base64url');

const createWebsiteSession = async (queryClient, {
  accountId,
  now = new Date(),
  expiresAt = new Date(now.getTime() + WEBSITE_SESSION_ABSOLUTE_TTL_MS),
  credential = createSessionCredential(),
} = {}) => {
  if (!Number.isInteger(Number(accountId)) || Number(accountId) <= 0) {
    throw new TypeError('A positive accountId is required to create a website session.');
  }
  const credentialHash = hashSessionCredential(credential);
  const result = await queryClient.query(
    `INSERT INTO public.website_sessions (
       account_id, credential_hash, created_at, last_seen_at, expires_at
     ) VALUES ($1, $2, $3, $3, $4)
     RETURNING id, account_id, created_at, last_seen_at, expires_at`,
    [Number(accountId), credentialHash, now, expiresAt]
  );
  return {
    ...result.rows[0],
    credential,
  };
};

const resolveWebsiteSession = async (queryClient, {
  accountId,
  credential,
  now = new Date(),
} = {}) => {
  if (!credential) return { ok: false, reason: 'missing' };
  const result = await queryClient.query(
    `SELECT id, account_id, created_at, last_seen_at, expires_at, revoked_at, revocation_reason
     FROM public.website_sessions
     WHERE account_id = $1 AND credential_hash = $2
     LIMIT 1`,
    [Number(accountId), hashSessionCredential(credential)]
  );
  const session = result.rows[0];
  if (!session) return { ok: false, reason: 'missing' };
  if (session.revoked_at) return { ok: false, reason: 'revoked', session };
  const expiresAt = toDate(session.expires_at);
  if (!expiresAt || expiresAt <= now) return { ok: false, reason: 'expired', session };
  return { ok: true, session };
};

const touchWebsiteSession = async (queryClient, {
  accountId,
  credential,
  now = new Date(),
} = {}) => {
  if (!credential) return null;
  const result = await queryClient.query(
    `UPDATE public.website_sessions
     SET last_seen_at = $3
     WHERE account_id = $1
       AND credential_hash = $2
       AND revoked_at IS NULL
       AND expires_at > $3
     RETURNING id, account_id, last_seen_at, expires_at`,
    [Number(accountId), hashSessionCredential(credential), now]
  );
  return result.rows[0] || null;
};

const revokeWebsiteSession = async (queryClient, {
  accountId,
  credential,
  now = new Date(),
  reason = 'logout',
} = {}) => {
  if (!credential) return null;
  const result = await queryClient.query(
    `UPDATE public.website_sessions
     SET revoked_at = COALESCE(revoked_at, $3),
         revocation_reason = COALESCE(revocation_reason, $4)
     WHERE account_id = $1 AND credential_hash = $2
     RETURNING id, account_id, revoked_at, revocation_reason`,
    [Number(accountId), hashSessionCredential(credential), now, String(reason || 'logout').slice(0, 100)]
  );
  return result.rows[0] || null;
};

const revokeAllWebsiteSessions = async (queryClient, {
  accountId,
  now = new Date(),
  reason = 'account_security_change',
} = {}) => queryClient.query(
  `UPDATE public.website_sessions
   SET revoked_at = COALESCE(revoked_at, $2),
       revocation_reason = COALESCE(revocation_reason, $3)
   WHERE account_id = $1 AND revoked_at IS NULL`,
  [Number(accountId), now, String(reason || 'account_security_change').slice(0, 100)]
);

const isFreshEligibleSession = (row, now, freshnessMs) => {
  if (!row || row.revoked_at) return false;
  const lastSeenAt = toDate(row.last_seen_at);
  const expiresAt = toDate(row.expires_at);
  return Boolean(lastSeenAt && expiresAt
    && expiresAt > now
    && lastSeenAt > new Date(now.getTime() - freshnessMs));
};

const normalizeRole = (role) => String(role || '').trim().toLowerCase()
  .replace(/[\s/-]+/g, '_');

const buildOnlinePresenceSnapshot = (
  rows,
  now = new Date(),
  freshnessMs = WEBSITE_SESSION_FRESHNESS_MS
) => {
  const accounts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isFreshEligibleSession(row, now, freshnessMs)) continue;
    const accountId = Number(row.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0 || accounts.has(accountId)) continue;
    accounts.set(accountId, normalizeRole(row.role));
  }

  const roles = Array.from(accounts.values());
  return {
    total: accounts.size,
    admins: roles.filter((role) => role === 'admin').length,
    teachers: roles.filter((role) => role === 'teacher' || role === 'parent_teacher').length,
    parents: roles.filter((role) => role === 'parent' || role === 'parent_teacher').length,
    parentTeachers: roles.filter((role) => role === 'parent_teacher').length,
  };
};

const getOnlinePresence = async (queryClient, {
  now = new Date(),
  freshnessMs = WEBSITE_SESSION_FRESHNESS_MS,
} = {}) => {
  const freshAfter = new Date(now.getTime() - freshnessMs);
  const result = await queryClient.query(
    `SELECT sessions.account_id,
            accounts.role,
            sessions.last_seen_at,
            sessions.expires_at,
            sessions.revoked_at
     FROM public.website_sessions sessions
     JOIN public.accounts accounts ON accounts.id = sessions.account_id
     WHERE sessions.revoked_at IS NULL
       AND sessions.expires_at > $1
       AND sessions.last_seen_at > $2
       AND COALESCE(accounts.is_archived, false) = false
       AND LOWER(accounts.role) = ANY($3::text[])`,
    [now, freshAfter, ['admin', 'teacher', 'parent', 'parent_teacher']]
  );
  return buildOnlinePresenceSnapshot(result.rows, now, freshnessMs);
};

module.exports = {
  WEBSITE_SESSION_ABSOLUTE_TTL_MS,
  WEBSITE_SESSION_FRESHNESS_MS,
  WEBSITE_SESSION_HEARTBEAT_INTERVAL_MS,
  WEBSITE_SESSION_DASHBOARD_REFRESH_MS,
  buildOnlinePresenceSnapshot,
  createWebsiteSession,
  getOnlinePresence,
  hashSessionCredential,
  resolveWebsiteSession,
  revokeAllWebsiteSessions,
  revokeWebsiteSession,
  touchWebsiteSession,
};
