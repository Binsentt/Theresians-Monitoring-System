import {
  createAdminChildDraft,
  toAdminParentChildrenPayload,
  validateAdminParentChildren,
} from './adminParentChildren.utils';

const registry = {
  grades: [
    { grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] },
    { grade_level: 'Grade 3', sections: ['Garnet', 'Jade'] },
  ],
};

const createdChild = (overrides = {}) => ({
  ...createAdminChildDraft('row-1'),
  firstName: 'Ava',
  middleInitial: 'M',
  lastName: 'Santos',
  gradeLevel: 'Grade 1',
  section: 'Amethyst',
  ...overrides,
});

test('requires at least one child and validates every new child before submission', () => {
  expect(validateAdminParentChildren([], registry).formError).toBe('At least one child is required.');

  const result = validateAdminParentChildren([createdChild()], registry);
  expect(result.isValid).toBe(true);
});

test('allows a legacy six-digit or modern eight-digit ID only for Link Existing Student', () => {
  const linkedSix = createdChild({ operation: 'link', studentId: '001234' });
  const linkedEight = createdChild({ operation: 'link', studentId: '00123456' });

  expect(validateAdminParentChildren([linkedSix], registry).isValid).toBe(true);
  expect(validateAdminParentChildren([linkedEight], registry).isValid).toBe(true);
});

test('distinguishes generated New Student from Existing Student import and normalizes dash formatting', () => {
  const existing = createdChild({ operation: 'existing', studentId: '17-000087' });
  expect(validateAdminParentChildren([existing], registry).isValid).toBe(true);
  expect(toAdminParentChildrenPayload([createdChild()])).toEqual([{
    operation: 'create',
    first_name: 'Ava',
    middle_initial: 'M',
    last_name: 'Santos',
    grade_level: 'Grade 1',
    section: 'Amethyst',
  }]);
  expect(toAdminParentChildrenPayload([existing])).toEqual([{
    operation: 'existing',
    student_id: '17000087',
    first_name: 'Ava',
    middle_initial: 'M',
    last_name: 'Santos',
    grade_level: 'Grade 1',
    section: 'Amethyst',
  }]);
});

test('rejects duplicate child IDs across create and link rows before the request', () => {
  const result = validateAdminParentChildren([
    createdChild({ operation: 'existing', studentId: '17-000087' }),
    createdChild({ clientId: 'row-2', operation: 'link', studentId: '17000087' }),
  ], registry);

  expect(result.isValid).toBe(false);
  expect(result.errors[1].studentId).toBe('Duplicate Student ID: 17000087.');
});

test('builds the exact atomic account payload without unsaved client-only keys', () => {
  const payload = toAdminParentChildrenPayload([
    createdChild({ operation: 'existing', studentId: '17-000087' }),
    createdChild({ clientId: 'row-2', operation: 'link', studentId: '654321' }),
  ]);

  expect(payload).toEqual([
    {
      operation: 'existing',
      student_id: '17000087',
      first_name: 'Ava',
      middle_initial: 'M',
      last_name: 'Santos',
      grade_level: 'Grade 1',
      section: 'Amethyst',
    },
    { operation: 'link', student_id: '654321' },
  ]);
});
