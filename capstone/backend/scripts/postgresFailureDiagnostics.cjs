'use strict';

function classifyPsqlFailure(result) {
  if (!result || result.status === 0) return 'none';
  if (result.error?.code === 'ETIMEDOUT') return 'timeout';

  const stderr = String(result.stderr || '');
  const match = stderr.match(/(?:ERROR|FATAL|PANIC):\s*([0-9A-Z]{5}):/i);
  if (match) return `sqlstate=${match[1].toUpperCase()}`;
  if (result.status === 2) {
    const safeConnectionCategories = [
      [/\bconnection refused\b|\bECONNREFUSED\b/i, 'connection-refused'],
      [/\b(?:connection|operation) timed out\b|\bETIMEDOUT\b/i, 'connection-timeout'],
      [/\bno route to host\b|\bnetwork is unreachable\b/i, 'network-unreachable'],
      [/\bcould not translate host name\b|\bname or service not known\b|\btemporary failure in name resolution\b/i, 'host-resolution-failure'],
      [/\bno password supplied\b|\bpassword authentication failed\b|\bauthentication failed\b/i, 'authentication-rejected'],
      [/\bno pg_hba\.conf entry\b|\bpg_hba\.conf rejects connection\b/i, 'authentication-rule-rejected'],
      [/\bdatabase\b[^\r\n]*\bdoes not exist\b/i, 'database-not-found'],
      [/\brole\b[^\r\n]*\bdoes not exist\b/i, 'role-not-found'],
      [/\bserver closed the connection unexpectedly\b|\bconnection to server was lost\b/i, 'server-connection-lost'],
      [/\bSSL error\b|\bcertificate verify failed\b|\bcertificate has expired\b/i, 'tls-validation-failure'],
    ];
    const category = safeConnectionCategories.find(([pattern]) => pattern.test(stderr));
    return category ? category[1] : 'connection-failure';
  }
  return 'unclassified-failure';
}

module.exports = { classifyPsqlFailure };
