const SECTION_REGISTRY = Object.freeze([
  Object.freeze({ grade_level: 'Grade 1', sections: Object.freeze(['Amethyst', 'Amber']) }),
  Object.freeze({ grade_level: 'Grade 2', sections: Object.freeze(['Diamond', 'Emerald']) }),
  Object.freeze({ grade_level: 'Grade 3', sections: Object.freeze(['Garnet', 'Jade']) }),
  Object.freeze({ grade_level: 'Grade 4', sections: Object.freeze(['Onyx', 'Moonstone']) }),
  Object.freeze({ grade_level: 'Grade 5', sections: Object.freeze(['Pearl']) }),
  Object.freeze({ grade_level: 'Grade 6', sections: Object.freeze(['Sardonyx', 'Zircon']) }),
]);

const normalizeText = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

const getSectionsForGrade = (gradeLevel) => {
  const grade = normalizeText(gradeLevel);
  const entry = SECTION_REGISTRY.find((candidate) => candidate.grade_level === grade);
  return entry ? [...entry.sections] : [];
};

const resolveCanonicalSection = (gradeLevel, section) => {
  const requested = normalizeText(section).toLowerCase();
  if (!requested) return null;
  return getSectionsForGrade(gradeLevel).find((candidate) => candidate.toLowerCase() === requested) || null;
};

const isValidGradeSection = (gradeLevel, section) => Boolean(resolveCanonicalSection(gradeLevel, section));

const getPublicSectionRegistrySnapshot = () => ({
  grades: SECTION_REGISTRY.map((entry) => ({
    grade_level: entry.grade_level,
    sections: [...entry.sections],
  })),
});

module.exports = {
  getPublicSectionRegistrySnapshot,
  getSectionsForGrade,
  isValidGradeSection,
  resolveCanonicalSection,
};
