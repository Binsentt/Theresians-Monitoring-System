import { apiUrl } from './api';

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

export const normalizeSectionRegistry = (payload = {}) => ({
  grades: Array.isArray(payload?.grades)
    ? payload.grades
      .map((entry) => {
        const gradeLevel = asString(entry?.grade_level);
        const sections = Array.isArray(entry?.sections)
          ? entry.sections.map(asString).filter(Boolean)
          : [];
        return gradeLevel && sections.length > 0
          ? { grade_level: gradeLevel, sections }
          : null;
      })
      .filter(Boolean)
    : [],
});

export const getSectionsForGrade = (registry, gradeLevel) => {
  const normalizedGradeLevel = asString(gradeLevel);
  return registry?.grades?.find((entry) => entry.grade_level === normalizedGradeLevel)?.sections || [];
};

export const isValidSectionForGrade = (registry, gradeLevel, section) => (
  getSectionsForGrade(registry, gradeLevel).includes(asString(section))
);

export const fetchSectionRegistry = async (fetchImpl = globalThis.fetch, options = {}) => {
  const response = await fetchImpl(apiUrl('/api/sections/registry'), options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || 'Unable to load available Sections.');
  }
  return normalizeSectionRegistry(payload);
};
