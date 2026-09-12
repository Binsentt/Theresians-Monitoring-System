const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('canonical milestone/activity migration is additive and idempotent', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '021_canonical_milestones_and_activity_contract.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS activity_event_id/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS duration_seconds/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.student_quest_milestones/i);
  assert.match(sql, /UNIQUE \(student_id, milestone_id, learning_cycle_version\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS activity_logs_student_activity_event_id_unique/i);
});
