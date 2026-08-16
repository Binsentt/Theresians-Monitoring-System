const hasTemporaryPasswordCredentialMetadata = (user) => {
  const issuedAt = new Date(user?.temporary_password_issued_at);
  const expiresAt = new Date(user?.temporary_password_expires_at);
  return !Number.isNaN(issuedAt.getTime())
    && !Number.isNaN(expiresAt.getTime())
    && expiresAt.getTime() > issuedAt.getTime();
};

const requiresInitialPasswordSetup = (user, now = new Date()) => {
  if (user?.must_change_password !== true || !hasTemporaryPasswordCredentialMetadata(user)) {
    return false;
  }

  return new Date(user.temporary_password_expires_at).getTime() > new Date(now).getTime();
};

const serializeUser = (user) => {
  if (!user) return null;
  const {
    password,
    otp_code,
    otp_expires_at,
    is_archived,
    must_change_password,
    temporary_password_issued_at,
    temporary_password_expires_at,
    session_version,
    ...rest
  } = user;
  return {
    ...rest,
    mustChangePassword: !!must_change_password,
    requiresInitialPasswordSetup: requiresInitialPasswordSetup({
      must_change_password,
      temporary_password_issued_at,
      temporary_password_expires_at,
    }),
    isArchived: !!is_archived,
  };
};

const buildAccountHealthCheckResponse = (rows = []) => ({
  status: 'Connected',
  total: Number.isFinite(Number(rows[0]?.total)) ? Number(rows[0].total) : rows.length,
});

module.exports = {
  buildAccountHealthCheckResponse,
  hasTemporaryPasswordCredentialMetadata,
  requiresInitialPasswordSetup,
  serializeUser,
};
