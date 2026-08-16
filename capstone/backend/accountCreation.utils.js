const normalizeAccountRole = (role) => {
  const value = String(role || '').trim().toLowerCase();
  if (['parent/teacher', 'parent-teacher', 'parent teacher', 'parent_teacher'].includes(value)) {
    return 'parent_teacher';
  }
  return value;
};

const formatRoleLabel = (role) => {
  const normalized = normalizeAccountRole(role);
  if (!normalized) return '';
  if (normalized === 'parent_teacher') return 'Parent/Teacher';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const shouldIncludeRoleInCredentialsEmail = (role) => {
  const normalized = normalizeAccountRole(role);
  return Boolean(normalized);
};

const resolveGeneratedAccountPassword = (_providedPassword, generatePassword) => ({
  password: generatePassword(),
  mustChangePassword: true,
});

const DEFAULT_CREDENTIAL_EMAIL_TIMEOUT_MS = 30000;

const resolveCredentialEmailDelivery = async (
  sendEmail,
  timeoutMs = DEFAULT_CREDENTIAL_EMAIL_TIMEOUT_MS
) => {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || DEFAULT_CREDENTIAL_EMAIL_TIMEOUT_MS));
  });

  try {
    return Boolean(await Promise.race([sendEmail(), timeout]));
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
};

const sanitizeCreatedUser = (createdUser = {}) => {
  const { password, otp_code, otp_expires_at, ...safeUser } = createdUser;
  return safeUser;
};

const buildAccountCreationResponse = ({ createdUser, emailSent, role, roleLabel }) => {
  const safeUser = sanitizeCreatedUser(createdUser);

  if (emailSent) {
    return {
      user: safeUser,
      emailSent: true,
    };
  }

  const label = roleLabel || formatRoleLabel(role) || 'Account';
  return {
    user: safeUser,
    emailSent: false,
    credentialDelivery: 'requires_regeneration',
    warning: `${label} account was created, but the credential email could not be sent. An administrator must issue a new temporary password.`,
  };
};

const buildCredentialsEmail = ({ email, password, role, name, appUrl = 'https://theresiansquest.com/login' }) => {
  const safeName = escapeHtml(name || 'User');
  const safeRole = escapeHtml(formatRoleLabel(role) || 'Account');
  const safeEmail = escapeHtml(email);
  const safePassword = escapeHtml(password);
  const safeAppUrl = escapeHtml(appUrl);

  return {
    subject: 'Your Saint Therese School Portal Account',
    html: `<!doctype html>
<html>
  <body style="margin: 0; padding: 0; background: #f1f5f9; font-family: Arial, Helvetica, sans-serif; color: #0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width: 100%; background: #f1f5f9; padding: 24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 620px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden;">
            <tr>
              <td style="background: #0b2447; color: #ffffff; padding: 24px 28px;">
                <h1 style="margin: 0; font-size: 22px; line-height: 1.3;">Saint Therese School Monitoring System</h1>
              </td>
            </tr>
            <tr>
              <td style="padding: 28px;">
                <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6;">Dear ${safeName},</p>
                <p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7;">Greetings from Saint Therese School.</p>
                <p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7;">Your account for the Theresian Monitoring System has been created successfully.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background: #f8fafc; border: 1px solid #dbe3ef; border-radius: 12px; padding: 18px; margin: 0 0 22px;">
                  <tr>
                    <td style="padding: 0 0 8px; color: #64748b; font-size: 13px; font-weight: 700; text-transform: uppercase;">Account Role:</td>
                  </tr>
                  <tr>
                    <td style="padding: 0 0 18px; color: #0f172a; font-size: 16px; font-weight: 700; word-break: break-word;">${safeRole}</td>
                  </tr>
                  <tr>
                    <td style="padding: 0 0 8px; color: #64748b; font-size: 13px; font-weight: 700; text-transform: uppercase;">Email:</td>
                  </tr>
                  <tr>
                    <td style="padding: 0 0 18px; color: #0f172a; font-size: 16px; font-weight: 700; word-break: break-word;">${safeEmail}</td>
                  </tr>
                  <tr>
                    <td style="padding: 0 0 8px; color: #64748b; font-size: 13px; font-weight: 700; text-transform: uppercase;">Temporary Password:</td>
                  </tr>
                  <tr>
                    <td style="padding: 0; color: #0f172a; font-size: 18px; font-weight: 800; word-break: break-word;">${safePassword}</td>
                  </tr>
                </table>
                <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.7;">Please login using the temporary password above. This temporary password expires in 30 minutes. You must change your password after logging in; kindly go to your Settings/Profile page and change your password for security.</p>
                <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.7;">Login here: <a href="${safeAppUrl}" style="color: #0b5ed7;">${safeAppUrl}</a></p>
                <p style="margin: 0 0 22px; font-size: 15px; line-height: 1.7;">Please keep your account credentials private and do not share them with others.</p>
                <p style="margin: 0; font-size: 15px; line-height: 1.7;">Thank you,<br/>Saint Therese School</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
};

module.exports = {
  buildAccountCreationResponse,
  buildCredentialsEmail,
  resolveCredentialEmailDelivery,
  resolveGeneratedAccountPassword,
  shouldIncludeRoleInCredentialsEmail,
};
