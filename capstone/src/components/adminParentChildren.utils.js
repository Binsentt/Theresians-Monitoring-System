import { getSectionsForGrade } from '../sectionRegistry';
import {
  validateChildProfile,
  validateGameStudentId,
  validateSchoolStudentId,
} from '../utils/validation.utils';

let nextDraftId = 1;

export const createAdminChildDraft = (clientId = `admin-child-${nextDraftId++}`) => ({
  clientId,
  operation: 'create',
  firstName: '',
  middleInitial: '',
  lastName: '',
  gradeLevel: '',
  section: '',
  studentId: '',
});

export const validateAdminParentChildren = (children, sectionRegistry) => {
  if (!Array.isArray(children) || children.length === 0) {
    return { isValid: false, formError: 'At least one child is required.', errors: [] };
  }

  const seenStudentIds = new Set();
  const errors = children.map((child) => {
    const rowErrors = {};
    const operation = String(child?.operation || '').trim().toLowerCase();
    const studentId = String(child?.studentId || '').trim();
    let canonicalStudentId = null;

    if (operation === 'link') {
      const idResult = validateGameStudentId(studentId);
      if (!idResult.isValid) rowErrors.studentId = idResult.error;
      else canonicalStudentId = idResult.value;
    } else if (operation === 'existing') {
      const idResult = validateSchoolStudentId(studentId);
      if (!idResult.isValid) rowErrors.studentId = idResult.error;
      else canonicalStudentId = idResult.value;
    } else if (operation === 'create') {
      Object.assign(rowErrors, validateChildProfile({
        ...child,
        sectionOptions: getSectionsForGrade(sectionRegistry, child?.gradeLevel),
        requireStudentId: false,
      }));
      if (studentId) rowErrors.studentId = 'Student IDs are generated automatically for new Students.';
    } else {
      rowErrors.operation = 'Choose Create New Student, Existing Student, or Link Existing System Student.';
    }

    if (canonicalStudentId && !rowErrors.studentId) {
      if (seenStudentIds.has(canonicalStudentId)) rowErrors.studentId = `Duplicate Student ID: ${canonicalStudentId}.`;
      else seenStudentIds.add(canonicalStudentId);
    }
    return rowErrors;
  });

  return {
    isValid: errors.every((rowErrors) => Object.keys(rowErrors).length === 0),
    formError: '',
    errors,
  };
};

export const toAdminParentChildrenPayload = (children) => (Array.isArray(children) ? children : []).map((child) => {
  const operation = String(child.operation || 'create').trim().toLowerCase();
  const rawStudentId = String(child.studentId || '').trim();
  const idResult = operation === 'existing' ? validateSchoolStudentId(rawStudentId) : validateGameStudentId(rawStudentId);
  const base = { operation };
  if (operation === 'link' || operation === 'existing') base.student_id = idResult.value || rawStudentId;
  if (operation === 'create') return {
    ...base,
    first_name: String(child.firstName || '').trim(),
    middle_initial: String(child.middleInitial || '').trim().replace(/\.$/, ''),
    last_name: String(child.lastName || '').trim(),
    grade_level: String(child.gradeLevel || '').trim(),
    section: String(child.section || '').trim().replace(/\s+/g, ' '),
  };
  if (operation === 'link') return base;
  return {
    ...base,
    first_name: String(child.firstName || '').trim(),
    middle_initial: String(child.middleInitial || '').trim().replace(/\.$/, ''),
    last_name: String(child.lastName || '').trim(),
    grade_level: String(child.gradeLevel || '').trim(),
    section: String(child.section || '').trim().replace(/\s+/g, ' '),
  };
});
