const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAccountCreationResponse,
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

test('account creation response exposes temporary password only when credential email fails', () => {
  const createdUser = {
    id: 42,
    name: 'Maria Santos',
    email: 'maria@gmail.com',
    role: 'teacher',
  };

  assert.deepEqual(
    buildAccountCreationResponse({
      createdUser,
      generatedPassword: 'Generated!2345',
      emailSent: true,
      roleLabel: 'Teacher',
    }),
    {
      user: createdUser,
      emailSent: true,
    }
  );

  assert.deepEqual(
    buildAccountCreationResponse({
      createdUser,
      generatedPassword: 'Generated!2345',
      emailSent: false,
      roleLabel: 'Teacher',
    }),
    {
      user: createdUser,
      emailSent: false,
      tempPassword: 'Generated!2345',
      warning: 'Teacher account was created, but the credential email could not be sent. Copy the temporary password now and share it securely with the user.',
    }
  );
});

test('account creation response never includes stored password fields', () => {
  const response = buildAccountCreationResponse({
    createdUser: {
      id: 43,
      name: 'Paula Parent',
      email: 'paula@gmail.com',
      role: 'parent',
      password: '$2b$10$hashed-value',
      otp_code: '123456',
    },
    generatedPassword: 'Generated!2345',
    emailSent: false,
    role: 'parent',
  });

  assert.equal(response.user.password, undefined);
  assert.equal(response.user.otp_code, undefined);
  assert.equal(response.tempPassword, 'Generated!2345');
});
