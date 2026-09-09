import { getSectionsForGrade } from '../sectionRegistry';
import {
  validateChildProfile,
  validateGameStudentId,
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

    if (operation === 'link') {
      const idResult = validateGameStudentId(studentId);
      if (!idResult.isValid) rowErrors.studentId = idResult.error;
    } else if (operation === 'create') {
      Object.assign(rowErrors, validateChildProfile({
        ...child,
        sectionOptions: getSectionsForGrade(sectionRegistry, child?.gradeLevel),
      }));
      if (/^\d{6}$/.test(studentId)) rowErrors.studentId = 'New Student IDs must be exactly 8 digits.';
    } else {
      rowErrors.operation = 'Choose Create New Student or Link Existing Student.';
    }

    if (studentId && !rowErrors.studentId) {
      if (seenStudentIds.has(studentId)) rowErrors.studentId = `Duplicate Student ID: ${studentId}.`;
      else seenStudentIds.add(studentId);
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
  const base = {
    operation,
    student_id: String(child.studentId || '').trim(),
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
