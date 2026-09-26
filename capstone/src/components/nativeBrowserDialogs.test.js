import fs from 'fs';
import path from 'path';

const SOURCE_ROOT = path.resolve(__dirname, '..');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const FORBIDDEN_NATIVE_DIALOG = /(?:\bwindow\.)?\b(?:confirm|alert|prompt)\s*\(/;

const collectSourceFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const resolved = path.join(directory, entry.name);
  if (entry.isDirectory()) return collectSourceFiles(resolved);
  if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [];
  if (/\.(?:test|spec)\.[jt]sx?$/.test(entry.name)) return [];
  return [resolved];
});

test('frontend source does not use native browser confirm, alert, or prompt dialogs', () => {
  const offenders = collectSourceFiles(SOURCE_ROOT)
    .filter((filePath) => FORBIDDEN_NATIVE_DIALOG.test(fs.readFileSync(filePath, 'utf8')))
    .map((filePath) => path.relative(SOURCE_ROOT, filePath));

  expect(offenders).toEqual([]);
});
