import fs from 'fs';
import path from 'path';

describe('dark mode readability guardrails', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, 'global.css'), 'utf8');

  test.each([
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
    'question-preview-add-editor',
  ])('gives %s a dark-theme surface override', (className) => {
    const escapedClass = className.replace(/\./g, '\\.');
    expect(styles).toMatch(new RegExp(
      `\\[data-theme='dark'\\][\\s\\S]{0,700}\\.${escapedClass}[\\s\\S]{0,500}background:\\s*(?:rgba|#)`,
      's'
    ));
  });

  test('keeps active and offline status tags readable on dark surfaces', () => {
    expect(styles).toMatch(/\[data-theme='dark'\] \.status-tag\.active\s*\{[^}]*background:\s*#064e3b[^}]*color:\s*#d1fae5/s);
    expect(styles).toMatch(/\[data-theme='dark'\][\s\S]*\.status-tag\.offline[\s\S]*background:\s*#374151[^}]*color:\s*#e5e7eb/s);
  });

  test('uses dark semantic backgrounds instead of leaving light-mode warning cards white', () => {
    const targetedBlock = styles.slice(styles.indexOf('Targeted dark-mode contrast fixes for nested semantic surfaces'));
    expect(targetedBlock).not.toMatch(/background(?:-color)?:\s*(?:white|#fff(?:fff)?|#fff[0-9a-f]{3})/i);
  });
});
