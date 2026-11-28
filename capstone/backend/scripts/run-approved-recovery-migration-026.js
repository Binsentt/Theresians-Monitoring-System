'use strict';

const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  ARTIFACT_FILES,
  buildRecoveryApprovalPlan,
  computeRecoveryArtifactSha256,
  computePreflightSqlSha256,
  runRecoveryMigration026,
} = require('./recoveryMigration026');
const { buildReleaseDatabaseConfig } = require('../releaseMigrations');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(BACKEND_ROOT, '../..');

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('could not verify the approved local source revision');
  return result.stdout.trim();
}

function inspectSourceState() {
  const sourceRevision = gitOutput(['rev-parse', '--verify', 'HEAD']);
  const status = gitOutput([
    'status', '--porcelain', '--untracked-files=all', '--',
    ...ARTIFACT_FILES.map((relativePath) => path.posix.join('capstone/backend', relativePath)),
  ]);
  return { sourceRevision, artifactTreeClean: status === '' };
}

function askVisible(prompt) {
  return new Promise((resolve, reject) => {
    const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
    interface_.question(prompt, (answer) => {
      interface_.close();
      resolve(answer);
    });
    interface_.on('error', (error) => {
      interface_.close();
      reject(error);
    });
  });
}

function askHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('interactive hidden authentication input is required'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const restore = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      process.stdout.write('\n');
    };
    const onError = () => {
      restore();
      reject(new Error('interactive authentication input failed'));
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          restore();
          reject(new Error('interactive authentication was cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          restore();
          resolve(value);
          return;
        }
        if (character === '\u0008' || character === '\u007f') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.on('error', onError);
  });
}

async function main() {
  const env = process.env;
  if (Object.prototype.hasOwnProperty.call(env, 'PGPASSWORD')) {
    throw new Error('remove PGPASSWORD from the process environment; recovery requires hidden interactive authentication');
  }
  const sourceState = inspectSourceState();
  const artifactSha256 = computeRecoveryArtifactSha256(BACKEND_ROOT);
  console.log(`Recovery source revision: ${sourceState.sourceRevision}`);
  console.log(`Recovery artifact SHA-256: ${artifactSha256}`);
  console.log(`Pre-026 preflight SQL SHA-256: ${computePreflightSqlSha256()}`);
  buildRecoveryApprovalPlan({
    env,
    sourceRevision: sourceState.sourceRevision,
    artifactSha256,
    artifactTreeClean: sourceState.artifactTreeClean,
  });
  const confirmation = await askVisible('Type APPLY-MIGRATION-026 to continue: ');
  if (confirmation !== 'APPLY-MIGRATION-026') throw new Error('explicit migration confirmation did not match');
  let password = '';
  let databaseConfig;
  try {
    password = await askHidden('PostgreSQL release-role password (input hidden): ');
    if (!password) throw new Error('PostgreSQL authentication was not provided');
    databaseConfig = buildReleaseDatabaseConfig(env, { password });
    await runRecoveryMigration026({
      env,
      sourceRevision: sourceState.sourceRevision,
      artifactSha256,
      artifactTreeClean: sourceState.artifactTreeClean,
      databaseConfig,
    });
  } finally {
    password = '';
    if (databaseConfig) databaseConfig.password = '';
  }
  console.log('Migration 026 completed and verified; post-migration release gates remain separate.');
}

if (require.main === module) {
  main().catch((error) => {
    const category = error?.category || 'approval-or-configuration';
    console.error(`Recovery migration stopped (${category}).`);
    process.exitCode = 1;
  });
}

module.exports = { inspectSourceState };
