'use strict';

const bcryptDefault = require('bcrypt');
const { buildDatabaseConfig } = require('../database/databaseConfig.utils');

const BCRYPT_ROUNDS = 10;
const QA_ENVIRONMENT = 'qa-owner-testing';
const QA_PROJECT_ID = 'dd2c27df-22e4-4ee0-82dc-a1c510b07d0c';
const QA_ENVIRONMENT_ID = '0ab9cd4e-5281-4a4b-a9c7-a521616194f1';

function assertQaBootstrapAllowed(env) {
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('QA Admin bootstrap refuses production execution.');
  }
  if (env.RAILWAY_ENVIRONMENT_NAME !== QA_ENVIRONMENT) {
    throw new Error(`QA Admin bootstrap is limited to ${QA_ENVIRONMENT}.`);
  }
  if (env.RAILWAY_PROJECT_ID !== QA_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID !== QA_ENVIRONMENT_ID) {
    throw new Error('QA Admin bootstrap is limited to the verified QA project and environment.');
  }
  if (env.QA_ADMIN_BOOTSTRAP_APPROVED !== 'true') {
    throw new Error('Explicit QA Admin bootstrap approval is required.');
  }
}

function readCredentials(env) {
  const email = String(env.QA_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(env.QA_ADMIN_PASSWORD || '');
  if (!env.DATABASE_URL) throw new Error('QA database configuration is required.');
  if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid QA Admin email is required.');
  }
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('QA Admin password must be 12–72 UTF-8 bytes.');
  }
  return { email, password };
}

async function runQaAdminBootstrap({
  env = process.env,
  pool: providedPool,
  poolFactory,
  bcrypt = bcryptDefault,
  logger = console,
} = {}) {
  assertQaBootstrapAllowed(env);
  const { email, password } = readCredentials(env);
  let ownsPool = false;
  const pool = providedPool || (() => {
    if (poolFactory) {
      ownsPool = true;
      return poolFactory(buildDatabaseConfig(env));
    }
    const { Pool } = require('pg');
    ownsPool = true;
    return new Pool(buildDatabaseConfig(env));
  })();

  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    // Serialize concurrent invocations for this normalized email so a retry
    // cannot race into creating a second account.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [email]);
    const existing = await client.query(
      `SELECT id, role, is_archived
         FROM public.accounts
        WHERE LOWER(BTRIM(email)) = $1
        LIMIT 1
        FOR UPDATE`,
      [email],
    );

    if (existing.rows.length > 0) {
      const account = existing.rows[0];
      const isActiveAdmin = String(account.role || '').toLowerCase() === 'admin'
        && account.is_archived !== true;
      await client.query('COMMIT');
      transactionOpen = false;
      if (!isActiveAdmin) return { created: false, reason: 'email-in-use' };
      logger.log('QA Admin already exists.');
      return { created: false, reason: 'already-exists' };
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const inserted = await client.query(
      `INSERT INTO public.accounts
         (name, email, password, role, status, is_archived, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      ['QA Operator', email, passwordHash, 'admin', 'Offline', false, false],
    );

    if (inserted.rows.length !== 1) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { created: false, reason: 'email-in-use' };
    }

    await client.query('COMMIT');
    transactionOpen = false;
    logger.log('QA Admin created.');
    return { created: true, reason: 'created' };
  } catch {
    if (client && transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve sanitized failure */ }
    }
    // Do not leak database errors, connection strings, or credential inputs.
    throw new Error('QA Admin bootstrap failed; no success was confirmed.');
  } finally {
    if (client) client.release();
    if (ownsPool && typeof pool.end === 'function') await pool.end();
  }
}

if (require.main === module) {
  runQaAdminBootstrap().catch(() => {
    console.error('QA Admin bootstrap failed; no success was confirmed.');
    process.exitCode = 1;
  });
}

module.exports = {
  assertQaBootstrapAllowed,
  runQaAdminBootstrap,
};
