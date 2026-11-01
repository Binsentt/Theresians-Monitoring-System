import fs from 'fs';
import path from 'path';

const readThemeVariables = (block) => Object.fromEntries(
  [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2]])
);

const luminance = (hex) => {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
};

const contrastRatio = (foreground, background) => {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

describe('dark mode semantic surface contrast', () => {
  const stylesheet = fs.readFileSync(path.resolve(__dirname, 'global.css'), 'utf8');
  const progressStylesheet = fs.readFileSync(path.resolve(__dirname, 'studentprogress.css'), 'utf8');
  const adminStylesheet = fs.readFileSync(path.resolve(__dirname, 'admindashboard.css'), 'utf8');
  const lightBlock = stylesheet.match(/:root\s*\{([^}]*)\}/s)?.[1] || '';
  const darkBlock = stylesheet.match(/\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/s)?.[1] || '';
  const light = readThemeVariables(lightBlock);
  const dark = { ...light, ...readThemeVariables(darkBlock) };
  const darkRules = [...stylesheet.matchAll(/\[data-theme=['"]dark['"]\][^{]*\{[^}]*\}/gs)].map((match) => match[0]);
  const darkRuleFor = (selector) => darkRules.find((rule) => rule.includes(selector)) || '';
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

  test('light semantic text and status fills meet WCAG AA contrast on white surfaces', () => {
    expect(contrastRatio(light['text-primary'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['text-muted'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['success-color'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['warning-color'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['error-color'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', light['success-surface-color'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', light['warning-surface-color'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', light['error-surface-color'])).toBeGreaterThanOrEqual(4.5);
  });

  test('dark semantic text and status fills meet WCAG AA contrast on dark surfaces', () => {
    expect(contrastRatio(dark['text-primary'], dark['panel-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['text-muted'], dark['panel-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['success-color'], dark['panel-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['warning-color'], dark['panel-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['error-color'], dark['panel-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', dark['success-surface-color'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', dark['warning-surface-color'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', dark['error-surface-color'])).toBeGreaterThanOrEqual(4.5);
  });

  test('dashboard metrics use the defined theme foreground rather than an undefined status token', () => {
    expect(stylesheet).toMatch(/\[data-theme=['"]dark['"]\]\s*\.metric-value\s*\{\s*color:\s*var\(--text-primary\)/);
    expect(adminStylesheet).toMatch(/\[data-theme=['"]dark['"]\]\s*\.metric-value\s*\{\s*color:\s*var\(--text-primary\)/);
  });

  test('Admin online and offline labels preserve readable semantic colors in light and dark themes', () => {
    expect(adminStylesheet).toMatch(/\.status-tag\.active\s*\{[^}]*background-color:\s*#dcfce7[^}]*color:\s*var\(--success-color/s);
    expect(adminStylesheet).toMatch(/\.status-tag\.offline\s*\{[^}]*background-color:\s*#edf2f7[^}]*color:\s*#475569/s);
    expect(adminStylesheet).toMatch(/\[data-theme=['"]dark['"]\]\s*\.status-tag\.active\s*\{[^}]*background-color:\s*#14532d[^}]*color:\s*#dcfce7/s);
    expect(adminStylesheet).toMatch(/\[data-theme=['"]dark['"]\]\s*\.status-tag\.offline\s*\{[^}]*background-color:\s*#374151[^}]*color:\s*#e5e7eb/s);
    expect(contrastRatio(light['success-color'], '#dcfce7')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#dcfce7', '#14532d')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#e5e7eb', '#374151')).toBeGreaterThanOrEqual(4.5);
  });

  test('Student and Parent progress panels retain dark theme surfaces and responsive single-column layout', () => {
    expect(progressStylesheet).toMatch(/\[data-theme=['"]dark['"]\]\s*\.grounded-ai-analysis\s+\.student-dashboard-card\s*\{[^}]*background:/s);
    expect(darkRuleFor('.child-activity-item')).toMatch(/background:\s*var\(--panel-bg\)/);
    expect(darkRuleFor(' table {')).toMatch(/background:\s*var\(--panel-bg\)/);
    expect(progressStylesheet).toMatch(/@media\s*\(max-width:\s*900px\)\s*\{[^}]*student-insight-guidance-grid/s);
  });
});
