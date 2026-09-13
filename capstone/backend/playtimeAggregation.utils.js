const toNonNegative = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const sessionPlaytimeSeconds = (session = {}) => {
  const explicitSeconds = Number(session.total_playtime_seconds);
  if (Number.isFinite(explicitSeconds) && explicitSeconds > 0) return Math.floor(explicitSeconds);
  return Math.floor(toNonNegative(session.total_playtime_minutes) * 60);
};

const canonicalPlaytimeSeconds = (sessions = [], { includePlaying = true } = {}) => (
  (Array.isArray(sessions) ? sessions : [])
    .filter((session) => includePlaying || String(session?.status || '').trim().toLowerCase() !== 'playing')
    .reduce((total, session) => total + sessionPlaytimeSeconds(session), 0)
);

module.exports = { canonicalPlaytimeSeconds, sessionPlaytimeSeconds };
