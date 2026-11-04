const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('server startup does not launch legacy six-digit Student deletion', () => {
  assert.doesNotMatch(serverSource, /permanentlyDeleteLegacySixDigitStudents/);
  assert.doesNotMatch(serverSource, /legacySixDigitStudentCleanupReady/);
});
