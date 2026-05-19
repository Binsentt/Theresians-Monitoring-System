const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAnnouncementRole,
  normalizeAnnouncementTarget,
  normalizeAnnouncementPayload,
  normalizeAnnouncementManagementPayload,
  normalizeAnnouncementActorPayload,
  canManageAnnouncement,
} = require('./announcements.utils');

test('normalizes allowed announcement author roles', () => {
  assert.equal(normalizeAnnouncementRole('Admin'), 'admin');
  assert.equal(normalizeAnnouncementRole(' teacher '), 'teacher');
  assert.equal(normalizeAnnouncementRole('parent'), null);
});

test('normalizes allowed announcement target roles', () => {
  assert.equal(normalizeAnnouncementTarget('Teacher'), 'teacher');
  assert.equal(normalizeAnnouncementTarget(' parents '), 'parent');
  assert.equal(normalizeAnnouncementTarget('student'), null);
});

test('normalizes announcement payload text fields', () => {
  assert.deepEqual(
    normalizeAnnouncementPayload({
      title: '  New Lesson  ',
      message: '  Grade 4 activity is ready.  ',
      created_by: '7',
      created_by_role: 'Teacher',
      target_role: 'Parent',
    }),
    {
      title: 'New Lesson',
      message: 'Grade 4 activity is ready.',
      createdBy: 7,
      createdByRole: 'teacher',
      targetRole: 'parent',
    }
  );
});

test('rejects incomplete announcement payloads', () => {
  assert.equal(normalizeAnnouncementPayload({ title: '', message: 'Hello', created_by: 1, created_by_role: 'admin', target_role: 'teacher' }), null);
  assert.equal(normalizeAnnouncementPayload({ title: 'Hi', message: '', created_by: 1, created_by_role: 'admin', target_role: 'teacher' }), null);
  assert.equal(normalizeAnnouncementPayload({ title: 'Hi', message: 'Hello', created_by: 'x', created_by_role: 'admin', target_role: 'teacher' }), null);
});

test('normalizes announcement management payloads', () => {
  assert.deepEqual(
    normalizeAnnouncementManagementPayload({
      title: '  Updated title  ',
      message: '  Updated message  ',
      actor_id: '9',
      actor_role: 'Admin',
    }),
    {
      title: 'Updated title',
      message: 'Updated message',
      actorId: 9,
      actorRole: 'admin',
    }
  );
});

test('rejects incomplete announcement management payloads', () => {
  assert.equal(normalizeAnnouncementManagementPayload({ title: '', message: 'Body', actor_id: 1, actor_role: 'admin' }), null);
  assert.equal(normalizeAnnouncementManagementPayload({ title: 'Title', message: '', actor_id: 1, actor_role: 'admin' }), null);
  assert.equal(normalizeAnnouncementManagementPayload({ title: 'Title', message: 'Body', actor_id: 'x', actor_role: 'admin' }), null);
  assert.equal(normalizeAnnouncementManagementPayload({ title: 'Title', message: 'Body', actor_id: 1, actor_role: 'parent' }), null);
});

test('normalizes announcement actor payloads from body or query-shaped objects', () => {
  assert.deepEqual(
    normalizeAnnouncementActorPayload({ actor_id: '12', actor_role: 'Teacher' }),
    { actorId: 12, actorRole: 'teacher' }
  );
  assert.deepEqual(
    normalizeAnnouncementActorPayload({ created_by: '8', created_by_role: 'Admin' }),
    { actorId: 8, actorRole: 'admin' }
  );
});

test('allows announcement management only for the original author and role', () => {
  assert.equal(canManageAnnouncement({ created_by: 3, created_by_role: 'admin' }, { actorId: 3, actorRole: 'admin' }), true);
  assert.equal(canManageAnnouncement({ created_by: 3, created_by_role: 'teacher' }, { actorId: 3, actorRole: 'admin' }), false);
  assert.equal(canManageAnnouncement({ created_by: 4, created_by_role: 'admin' }, { actorId: 3, actorRole: 'admin' }), false);
});
