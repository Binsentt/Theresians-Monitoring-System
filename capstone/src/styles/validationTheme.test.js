import fs from 'fs';
import path from 'path';

const readSource = (relativePath) => fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');

describe('site-wide validation message theme contract', () => {
  const globalStyles = readSource('./global.css');
  const manageUsersStyles = readSource('./manageusers.css');
  const parentStyles = readSource('./parentdashboard.css');
  const resetPasswordStyles = readSource('./resetpassword.css');
  const validationBlock = globalStyles.slice(globalStyles.indexOf('/* Shared semantic validation text colors'));

  const validationClasses = [
    'validation-error-text',
    'error-text',
    'field-error',
    'sts-field-error',
    'sts-field-status.status-error',
    'id-directory-error',
    'id-directory-field-error',
    'activity-log-reset-error',
    'learning-cycle-reset-error',
    'manager-inline-error',
    'screen-time-error',
    'parent-add-child-request-error',
    'announcement-status-error',
    'notification-error',
    'error-message',
    'al-error',
    'ta-error',
  ];

  const mountStyles = (theme) => {
    const style = document.createElement('style');
    const errorColor = theme === 'dark' ? '#f87171' : '#b91c1c';
    const primaryColor = theme === 'dark' ? '#f1f5f9' : '#0b2447';
    const mutedColor = theme === 'dark' ? '#94a3b8' : '#64748b';
    style.textContent = `
      .error-text { color: #dc3545; }
      .field-help { color: #64748b; }
      .success { color: #16a34a; }
      [data-theme='dark'] .dashboard-sts-container .sts-main-panel,
      [data-theme='dark'] .dashboard-sts-container .sts-main-panel *,
      [data-theme='dark'] .settings-container .settings-main,
      [data-theme='dark'] .settings-container .settings-main * { color: #f1f5f9 !important; }
      [data-theme='dark'] input:not([type='checkbox']):not([type='radio']) { border-color: #475569 !important; }
      ${validationBlock
        .replace(/var\(--validation-error-color(?:,\s*[^)]+)?\)/g, errorColor)
        .replace(/var\(--text-primary(?:,\s*[^)]+)?\)/g, primaryColor)
        .replace(/var\(--text-muted(?:,\s*[^)]+)?\)/g, mutedColor)}
    `;
    document.head.appendChild(style);
    return () => style.remove();
  };

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = '';
    document.head.querySelectorAll('style').forEach((style) => style.remove());
  });

  test.each(validationClasses)('%s is covered by the shared validation color contract', (className) => {
    expect(globalStyles).toContain(`.${className}`);
  });

  test('Manage Users required, Add/Edit, reason, and DELETE errors keep field and text semantics', () => {
    const manageUsersSource = readSource('../components/ManageUsers.js');
    const manageUsersTests = readSource('../components/ManageUsers.test.js');
    const lessonManagerSource = readSource('../components/LessonQuestionManager.js');
    const settingsSource = readSource('../components/SettingsScreen.js');

    expect(manageUsersSource).toContain('className="error-text"');
    expect(manageUsersSource).toContain('className="sts-form" noValidate');
    expect(manageUsersSource).toContain('className="sts-form edit-user-form" noValidate');
    expect(lessonManagerSource).toContain('drive-upload-modal" onSubmit={handleUpload} noValidate');
    expect(settingsSource).toContain('className="profile-form" noValidate');
    expect(manageUsersSource).toContain("'deletion-reason-textarea error'");
    expect(manageUsersSource).toContain("'delete-confirmation-input error'");
    expect(manageUsersTests).toContain("permanentRequiredError.textContent).toBe('Please fill out this field.')");
    expect(manageUsersTests).toContain("typedConfirmation.classList.contains('error')");
    expect(manageUsersTests).toContain("requiredReasonError.classList.contains('error-text')");
  });

  test('Parent-child, Announcement, Lesson Manager, auth, and Settings use explicit validation text classes', () => {
    expect(readSource('../components/AdminParentChildren.jsx')).toContain('className="error-text"');
    expect(readSource('../components/AnnouncementPage.js')).toContain('className="field-error"');
    expect(readSource('../components/LessonQuestionManager.js')).toContain('className="manager-inline-error"');
    expect(readSource('../components/LoginScreen.js')).toContain('className="sts-field-error"');
    expect(readSource('../components/ResetPassword.js')).toContain('className="sts-field-error"');
    expect(readSource('../components/ResetPassword.js')).toContain('status-${statusTone}');
    expect(resetPasswordStyles).toContain('.sts-field-status.status-error');
    expect(resetPasswordStyles).toContain('.sts-field-status.status-success');
    expect(readSource('../components/SettingsScreen.js')).toContain('className="error-text"');
    [
      'AdminStudentProgress.js',
      'StudentAnalytics.js',
      'StudentProgress.js',
      'TeacherStudentProgress.js',
      'ParentChildProgress.js',
      'ParentDashboard.js',
      'ActivityLog.js',
      'TeacherDashboard.js',
    ].forEach((file) => {
      expect(readSource(`../components/${file}`)).toContain('validation-error-text');
    });
  });

  test('the dark-mode batch gives Edit/temporary-password and Parent-child surfaces theme-aware colors', () => {
    expect(manageUsersStyles).toContain('[data-theme=\'dark\'] .modal-content');
    expect(manageUsersStyles).toContain('.manage-user-readonly-value');
    expect(manageUsersStyles).toContain('background: var(--bg-secondary, #f8fafc)');
    expect(manageUsersStyles).toContain('.manage-users-temp-password-info');
    expect(manageUsersStyles).toContain('[data-theme=\'dark\'] .admin-parent-child-card');
    expect(parentStyles).toContain('[data-theme=\'dark\'] .parent-add-child-modal');
    expect(parentStyles).toContain('[data-theme=\'dark\'] .parent-add-child-form input');
  });

  test.each(['dark', 'light'])('%s-mode validation keeps both message text and field border red', (theme) => {
    const removeStyles = mountStyles(theme);
    document.documentElement.setAttribute('data-theme', theme);
    const dashboard = document.createElement('div');
    dashboard.className = 'dashboard-sts-container';
    dashboard.innerHTML = '<main class="sts-main-panel"><input aria-invalid="true" aria-describedby="field-error"><p id="field-error" class="error-text" role="alert">Please fill out this field.</p><p class="field-help">Helpful explanation</p><p class="success">Saved successfully</p></main>';
    document.body.appendChild(dashboard);

    const error = dashboard.querySelector('.error-text');
    const field = dashboard.querySelector('input');
    const helper = dashboard.querySelector('.field-help');
    const success = dashboard.querySelector('.success');
    const expectedRed = theme === 'dark' ? 'rgb(248, 113, 113)' : 'rgb(185, 28, 28)';
    expect(window.getComputedStyle(error).color).toBe(expectedRed);
    expect(window.getComputedStyle(field).borderTopColor).toBe(theme === 'dark' ? '#f87171' : '#b91c1c');
    expect(window.getComputedStyle(helper).color).not.toBe(expectedRed);
    expect(window.getComputedStyle(success).color).not.toBe(expectedRed);
    const semanticErrors = validationClasses.map((className) => {
      const message = document.createElement('p');
      message.className = className.replaceAll('.', ' ');
      message.textContent = 'Validation error';
      dashboard.querySelector('.sts-main-panel').appendChild(message);
      return message;
    });
    semanticErrors.forEach((message) => expect(window.getComputedStyle(message).color).toBe(expectedRed));
    removeStyles();
  });

  test('dark-mode dashboard text override cannot recolor validation messages or helper text', () => {
    const removeStyles = mountStyles('dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    const dashboard = document.createElement('div');
    dashboard.className = 'dashboard-sts-container';
    dashboard.innerHTML = '<main class="sts-main-panel"><p class="error-text">Invalid field</p><p class="field-help">Helpful explanation</p></main>';
    document.body.appendChild(dashboard);

    const error = dashboard.querySelector('.error-text');
    const helper = dashboard.querySelector('.field-help');
    expect(window.getComputedStyle(error).color).toBe('rgb(248, 113, 113)');
    expect(window.getComputedStyle(helper).color).not.toBe(window.getComputedStyle(error).color);
    removeStyles();
  });

  test('the shared validation color override is scoped to semantic error classes', () => {
    expect(validationBlock).toMatch(/\.error-text[\s\S]*\.field-error/);
    expect(validationBlock).not.toMatch(/\.dashboard-sts-container\s*\*\s*\{[^}]*color:\s*(?:red|#f87171)/i);
    expect(validationBlock).not.toMatch(/\.field-help\s*\{[^}]*color:\s*var\(--validation-error-color/);
  });
});
