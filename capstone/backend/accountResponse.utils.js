const serializeUser = (user) => {
  if (!user) return null;
  const { password, otp_code, otp_expires_at, is_archived, must_change_password, session_version, ...rest } = user;
  return {
    ...rest,
    mustChangePassword: !!must_change_password,
    isArchived: !!is_archived,
  };
};

const buildAccountHealthCheckResponse = (rows = []) => ({
  status: 'Connected',
  total: Number.isFinite(Number(rows[0]?.total)) ? Number(rows[0].total) : rows.length,
});

module.exports = {
  buildAccountHealthCheckResponse,
  serializeUser,
};
