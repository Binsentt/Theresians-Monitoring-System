import fs from 'fs';
import path from 'path';

describe('dark mode semantic surface contrast', () => {
  const stylesheet = fs.readFileSync(path.resolve(__dirname, 'global.css'), 'utf8');
  const selectors = [
    'announcement-banner-success',
    'announcement-banner-error',
    'al-error',
    'temporary-password-warning',
    'temporary-password-settings-warning',
    'manager-ai-pause-banner',
    'parent-progress-archived-notice',
    'grounded-ai-status.preliminary',
    'grounded-ai-status.warning',
    'fixed-question-validation-review',
    'generated-question-card.invalid',
    'manager-status-pill.staged',
    'manager-status-pill.generating',
    'manager-status-pill.failed',
    'manager-status-pill.superseded',
  ];

  test.each(selectors)('%s has a dark-theme background and foreground override', (selector) => {
    const escaped = selector.replace(/\./g, '\\.');
    const rule = new RegExp(
      `\\[data-theme=['\"]dark['\"]\\][^{}]*\\.${escaped}[^{}]*\\{[^}]*background(?:-color)?:[^}]*color:` ,
      's',
    );

    expect(stylesheet).toMatch(rule);
  });
});
