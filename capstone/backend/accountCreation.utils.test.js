const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCredentialsEmail,
  resolveGeneratedAccountPassword,
  shouldIncludeRoleInCredentialsEmail,
} = require('./accountCreation.utils');

test('account creation always uses a generated temporary password', () => {
  const result = resolveGeneratedAccountPassword('ManualPassword123!', () => 'Generated!2345');

  assert.equal(result.password, 'Generated!2345');
  assert.equal(result.mustChangePassword, true);
});

test('parent and teacher credential emails omit role labels', () => {
  assert.equal(shouldIncludeRoleInCredentialsEmail('parent'), false);
  assert.equal(shouldIncludeRoleInCredentialsEmail('Teacher'), false);

  const parentEmail = buildCredentialsEmail({
    email: 'parent@gmail.com',
    password: 'Generated!2345',
    role: 'parent',
    name: 'Parent User',
    appUrl: 'http://localhost:3000/login',
  });

  assert.equal(parentEmail.subject, 'Welcome to Theresian Portal');
  assert.match(parentEmail.html, /Hello, Parent User!/);
  assert.match(parentEmail.html, /Email\/Username:/);
  assert.match(parentEmail.html, /Temporary Password:/);
  assert.doesNotMatch(parentEmail.html, /Role:\s*Parent/i);
});

test('future non-parent-teacher roles can still include role text when needed', () => {
  assert.equal(shouldIncludeRoleInCredentialsEmail('admin'), true);

  const email = buildCredentialsEmail({
    email: 'admin@gmail.com',
    password: 'Generated!2345',
    role: 'admin',
    name: 'Admin User',
    appUrl: 'http://localhost:3000/login',
  });

  assert.match(email.html, /Account Type:/);
  assert.match(email.html, /Admin/);
});
