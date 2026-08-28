import fs from 'fs';
import path from 'path';

describe('Lesson Manager Preview viewport containment styles', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, 'lessonQuestionManager.css'), 'utf8');
  const rule = (selector) => styles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';

  test('contains the Preview modal inside a padded fixed viewport while its body remains the scroll region', () => {
    const overlay = rule('\\.manager-modal-backdrop');
    const previewOverlay = rule('\\.generated-questions-preview-backdrop');
    const previewModal = rule('\\.generated-questions-preview-modal');
    const previewBody = rule('\\.generated-questions-preview-body');
    const bodyScrollLock = rule('body\\.lesson-preview-open');
    const pageScrollLock = rule('\\.lesson-preview-scroll-locked');

    expect(overlay).toContain('position: fixed');
    expect(overlay).toContain('inset: 0');
    expect(previewOverlay).toContain('overflow: hidden');
    expect(previewOverlay).toContain('overscroll-behavior: none');
    expect(previewOverlay).toContain('box-sizing: border-box');
    expect(previewModal).toContain('box-sizing: border-box');
    expect(previewModal).toContain('height: min(88dvh, 760px)');
    expect(previewModal).toContain('max-height: 100%');
    expect(previewModal).toContain('min-height: 0');
    expect(bodyScrollLock).toContain('overflow: hidden');
    expect(pageScrollLock).toContain('overflow-y: hidden');
    expect(previewBody).toContain('min-height: 0');
    expect(previewBody).toContain('overflow-y: auto');
  });
});
