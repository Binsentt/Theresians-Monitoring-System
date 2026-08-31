import {
  getSectionsForGrade,
  isValidSectionForGrade,
  normalizeSectionRegistry,
} from './sectionRegistry';

test('normalizes the backend-owned Section registry without a local Grade map', () => {
  const registry = normalizeSectionRegistry({
    grades: [
      { grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] },
      { grade_level: 'Grade 2', sections: ['Diamond', 'Emerald'] },
    ],
  });

  expect(getSectionsForGrade(registry, 'Grade 1')).toEqual(['Amethyst', 'Amber']);
  expect(getSectionsForGrade(registry, 'Grade 2')).toEqual(['Diamond', 'Emerald']);
  expect(isValidSectionForGrade(registry, 'Grade 1', 'Amber')).toBe(true);
  expect(isValidSectionForGrade(registry, 'Grade 1', 'Emerald')).toBe(false);
});
