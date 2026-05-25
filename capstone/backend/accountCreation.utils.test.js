const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAccountCreationResponse,
  buildCredentialsEmail,
  resolveGeneratedAccountPassword,
  resolveCredentialEmailDelivery,
  shouldIncludeRoleInCredentialsEmail,
} = require('./accountCreation.utils');

test('account creation always uses a generated temporary password', () => {
  const result = resolveGeneratedAccountPassword('ManualPassword123!', () => 'Generated!2345');

  assert.equal(result.password, 'Generated!2345');
  assert.equal(result.mustChangePassword, true);
});

test('credential email builder uses the approved Saint Therese welcome letter', () => {
  assert.equal(shouldIncludeRoleInCredentialsEmail('parent'), true);
  assert.equal(shouldIncludeRoleInCredentialsEmail('Teacher'), true);

  const parentEmail = buildCredentialsEmail({
    email: 'parent@gmail.com',
    password: 'Generated!2345',
    role: 'parent',
    name: 'Parent User',
    appUrl: 'http://localhost:3000/login',
  });

  assert.equal(parentEmail.subject, 'Welcome to Saint Therese School Portal \u2014 Your Account is Ready');
  assert.match(parentEmail.html, /Dear Parent User,/);
  assert.match(parentEmail.html, /Welcome to the Saint Therese School Monitoring System!/);
  assert.match(parentEmail.html, /Your account has been created by the school administrator/);
  assert.match(parentEmail.html, /Account Role:/);
  assert.match(parentEmail.html, /Parent/);
  assert.match(parentEmail.html, /Email:/);
  assert.match(parentEmail.html, /Temporary Password:/);
  assert.match(parentEmail.html, /Please login using the generated password first, then change your password in Settings after logging in\./);
  assert.match(parentEmail.html, /Monitoring and Learning Portal/);
});

test('credential email builder includes account role for generated-password recipients', () => {
  const email = buildCredentialsEmail({
    email: 'teacher@gmail.com',
    password: 'Generated!2345',
    role: 'teacher',
    name: 'Teacher User',
    appUrl: 'http://localhost:3000/login',
  });

  assert.match(email.html, /Dear Teacher User,/);
  assert.match(email.html, /Account Role:/);
  assert.match(email.html, /Teacher/);
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

test('credential email delivery resolves false when sending stalls past the timeout', async () => {
  const result = await resolveCredentialEmailDelivery(
    () => new Promise(() => {}),
    5
  );

  assert.equal(result, false);
});

test('credential email delivery returns the send result when it finishes before timeout', async () => {
  const result = await resolveCredentialEmailDelivery(
    async () => true,
    100
  );

  assert.equal(result, true);
});
