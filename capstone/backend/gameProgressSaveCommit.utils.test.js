const assert = require('node:assert/strict');
const test = require('node:test');

const {
  inspectSaveCommitId,
  hashProgressSavePayload,
  hashSaveCommitId,
  buildProgressActivityEventKey,
} = require('./gameProgressSaveCommit.utils');

test('save commit IDs accept the game manual and daily-limit formats while keeping legacy omission valid', () => {
  assert.deepEqual(inspectSaveCommitId({}), { provided: false, valid: true, value: null });
  assert.equal(inspectSaveCommitId({ save_commit_id: 'manual:12345678:4:12' }).valid, true);
  assert.equal(inspectSaveCommitId({ save_commit_id: 'daily-limit:12345678:2026-11-02' }).valid, true);
});

test('save commit IDs reject empty, malformed, non-string, non-ASCII, and oversized values', () => {
  for (const value of ['', 123, null, 'id with spaces', 'id/with/slash', 'id\nwith-control', 'é-id', 'x'.repeat(129)]) {
    assert.equal(inspectSaveCommitId({ save_commit_id: value }).valid, false, `rejected ${String(value).slice(0, 24)}`);
  }
  assert.equal(inspectSaveCommitId({ save_commit_id: 'x'.repeat(128) }).valid, true);
});

test('business payload hash is canonical and changes when an effective field changes', () => {
  assert.equal(
    hashProgressSavePayload({ score: 8, progress: { b: 2, a: 1 } }),
    hashProgressSavePayload({ progress: { a: 1, b: 2 }, score: 8 }),
  );
  assert.notEqual(
    hashProgressSavePayload({ score: 8, progress: { a: 1 } }),
    hashProgressSavePayload({ score: 9, progress: { a: 1 } }),
  );
});

test('receipt and activity identity is deterministic and scoped to cycle', () => {
  const commitHash = hashSaveCommitId('manual:12345678:4:12');
  assert.equal(commitHash, hashSaveCommitId('manual:12345678:4:12'));
  assert.notEqual(commitHash, hashSaveCommitId('manual:12345678:4:13'));
  assert.notEqual(
    buildProgressActivityEventKey(4, commitHash),
    buildProgressActivityEventKey(5, commitHash),
  );
});
