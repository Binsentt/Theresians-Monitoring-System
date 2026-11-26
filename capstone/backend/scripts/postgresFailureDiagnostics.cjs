'use strict';

function classifyPsqlFailure(result) {
  if (!result || result.status === 0) return 'none';
  if (result.error?.code === 'ETIMEDOUT') return 'timeout';
  if (result.status === 2) return 'connection-failure';

  const stderr = String(result.stderr || '');
  const match = stderr.match(/(?:ERROR|FATAL|PANIC):\s*([0-9A-Z]{5}):/i);
  if (match) return `sqlstate=${match[1].toUpperCase()}`;
  return 'unclassified-failure';
}

module.exports = { classifyPsqlFailure };
