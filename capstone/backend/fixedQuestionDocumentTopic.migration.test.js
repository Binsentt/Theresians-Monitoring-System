const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('document-topic migration is additive and permits an unscoped fixed-question document without rewriting historical topics', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, 'migrations', '011_add_learning_file_document_topic.sql'),
    'utf8'
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS document_topic/i);
  assert.match(migration, /ALTER COLUMN math_topic DROP NOT NULL/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.learning_files/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
});
