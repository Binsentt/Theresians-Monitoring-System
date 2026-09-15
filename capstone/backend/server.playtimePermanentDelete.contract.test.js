const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('permanent Screen Time deletion is Admin-only, target-bound, archived-only, transactional, and tombstoned', () => {
  assert.match(source, /app\.get\('\/api\/playtime\/:id\/permanent-delete-preview', requireAccountManagementAdmin/);
  assert.match(source, /app\.post\('\/api\/playtime\/:id\/permanent-delete', requireAccountManagementAdmin/);
  const route = source.slice(source.indexOf("app.post('/api/playtime/:id/permanent-delete'"), source.indexOf("app.post('/api/playtime/:id/reset'"));
  assert.match(route, /confirmation !== 'DELETE'/);
  assert.match(route, /deleted_at IS NOT NULL/);
  assert.match(route, /BEGIN/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /playtime_deletion_tombstones/);
  assert.match(route, /DELETE FROM public\.playtime_sessions/);
  assert.match(route, /COMMIT/);
});
