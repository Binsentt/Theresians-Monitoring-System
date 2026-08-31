const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPublicSectionRegistrySnapshot,
  getSectionsForGrade,
  isValidGradeSection,
} = require('./sectionRegistry');

test('exposes the approved canonical Grade-to-Section membership only', () => {
  assert.deepEqual(getPublicSectionRegistrySnapshot(), {
    grades: [
      { grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] },
      { grade_level: 'Grade 2', sections: ['Diamond', 'Emerald'] },
      { grade_level: 'Grade 3', sections: ['Garnet', 'Jade'] },
      { grade_level: 'Grade 4', sections: ['Onyx', 'Moonstone'] },
      { grade_level: 'Grade 5', sections: ['Pearl'] },
      { grade_level: 'Grade 6', sections: ['Sardonyx', 'Zircon'] },
    ],
  });
  assert.deepEqual(getSectionsForGrade('Grade 1'), ['Amethyst', 'Amber']);
  assert.equal(isValidGradeSection('Grade 1', 'Amethyst'), true);
  assert.equal(isValidGradeSection('Grade 1', 'Emerald'), false);
  assert.equal(isValidGradeSection('Grade 5', 'Pearl'), true);
  assert.equal(isValidGradeSection('Grade 5', 'Amethyst'), false);
});
