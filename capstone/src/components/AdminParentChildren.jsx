import React, { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../api';
import { getSectionsForGrade } from '../sectionRegistry';
import {
  PARENT_CHILD_GRADE_OPTIONS,
  validateGameStudentId,
  validateSchoolStudentId,
} from '../utils/validation.utils';
import { createAdminChildDraft } from './adminParentChildren.utils';

const ErrorText = ({ children }) => children ? <span className="error-text" role="alert">{children}</span> : null;
const EMPTY_HEADERS = Object.freeze({});

const localIdError = (operation, studentId) => {
  if (!studentId) return '';
  const result = operation === 'existing'
    ? validateSchoolStudentId(studentId)
    : validateGameStudentId(studentId);
  return result.error || '';
};

export default function AdminParentChildren({
  value = [],
  onChange,
  sectionRegistry,
  errors = [],
  formError = '',
  authHeaders = EMPTY_HEADERS,
  onValidationStateChange,
}) {
  const children = Array.isArray(value) ? value : [];
  const [eligibility, setEligibility] = useState({});
  const validationVersion = useRef(0);

  useEffect(() => {
    const version = ++validationVersion.current;
    let active = true;
    const initial = {};
    const candidates = [];
    children.forEach((child, index) => {
      const key = child.clientId || String(index);
      const operation = ['existing', 'link'].includes(child.operation) ? child.operation : 'create';
      const studentId = String(child.studentId || '').trim();
      const error = localIdError(operation, studentId);
      if (operation === 'create') initial[key] = { status: 'idle', error: '' };
      else if (!studentId) initial[key] = { status: 'error', error: operation === 'existing'
        ? 'Student ID must be 8 digits (for example, 17000087 or 17-000087).'
        : 'Student ID is required.' };
      else if (error) initial[key] = { status: 'error', error };
      else {
        initial[key] = { status: 'pending', error: '' };
        candidates.push({ key, operation, studentId });
      }
    });
    setEligibility(initial);

    if (candidates.length === 0) return () => { active = false; };
    const timer = setTimeout(async () => {
      const completed = { ...initial };
      await Promise.all(candidates.map(async ({ key, operation, studentId }) => {
        try {
          const params = new URLSearchParams({ student_id: studentId, operation });
          const response = await fetch(apiUrl(`/api/accounts/student-link-eligibility?${params.toString()}`), {
            headers: authHeaders,
          });
          const payload = await response.json().catch(() => ({}));
          completed[key] = response.ok && payload.available
            ? { status: 'valid', error: '' }
            : { status: 'error', error: payload.error || 'This Student ID is not available.' };
        } catch (_error) {
          completed[key] = { status: 'error', error: 'Unable to validate this Student ID. Try again.' };
        }
      }));
      if (active && validationVersion.current === version) setEligibility(completed);
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [children, authHeaders?.Authorization]);

  useEffect(() => {
    if (!onValidationStateChange) return;
    const states = children.map((child, index) => eligibility[child.clientId || String(index)] || { status: 'idle' });
    onValidationStateChange({
      pending: states.some(({ status }) => status === 'pending'),
      isValid: children.length > 0 && states.every(({ status }) => status === 'valid' || status === 'idle'),
    });
  }, [children, eligibility, onValidationStateChange]);
  const updateChild = (index, updates) => {
    onChange?.(children.map((child, childIndex) => (
      childIndex === index ? { ...child, ...updates } : child
    )));
  };
  const addChild = () => onChange?.([...children, createAdminChildDraft()]);
  const removeChild = (index) => {
    if (children.length <= 1) return;
    onChange?.(children.filter((_, childIndex) => childIndex !== index));
  };

  return (
    <section className="admin-parent-children" aria-labelledby="admin-parent-children-title">
      <div className="admin-parent-children-heading">
        <div>
          <h4 id="admin-parent-children-title">Children *</h4>
          <p>Create or link at least one Student in the same account transaction.</p>
        </div>
        <button type="button" className="sts-add-btn semantic-action-add" data-action="add-child" onClick={addChild}>Add Another Child</button>
      </div>
      {formError && <p className="error-text" role="alert">{formError}</p>}

      {children.map((child, index) => {
        const rowErrors = errors[index] || {};
        const childNumber = index + 1;
        const isLink = child.operation === 'link';
        const isExisting = child.operation === 'existing';
        const sections = getSectionsForGrade(sectionRegistry, child.gradeLevel);
        const eligibilityState = eligibility[child.clientId || String(index)] || { status: 'idle', error: '' };
        const eligibilityErrorId = `admin-child-${index}-student-id-error`;
        return (
          <fieldset className="admin-parent-child-card" key={child.clientId || index}>
            <legend>Child {childNumber}</legend>
            {children.length > 1 && (
              <button
                type="button"
                className="admin-parent-child-remove"
                aria-label={`Remove Child ${childNumber}`}
                onClick={() => removeChild(index)}
              >
                Remove
              </button>
            )}

            <div className="form-group">
              <label htmlFor={`admin-child-${index}-operation`}>Student setup *</label>
              <select
                id={`admin-child-${index}-operation`}
                className="sts-input"
                aria-label={`Child ${childNumber} account action`}
                value={child.operation}
                onChange={(event) => {
                  const operation = event.target.value;
                  updateChild(index, { operation, ...(operation === 'create' ? { studentId: '' } : {}) });
                }}
              >
                <option value="create">Create New Student</option>
                <option value="existing">Existing Student</option>
                <option value="link">Link Existing Student</option>
              </select>
              <ErrorText>{rowErrors.operation}</ErrorText>
            </div>

            {!isLink && (
              <>
                <div className="form-group">
                  <label htmlFor={`admin-child-${index}-first-name`}>First Name *</label>
                  <input id={`admin-child-${index}-first-name`} className="sts-input" aria-label={`Child ${childNumber} first name`} value={child.firstName} onChange={(event) => updateChild(index, { firstName: event.target.value })} />
                  <ErrorText>{rowErrors.firstName}</ErrorText>
                </div>
                <div className="form-group">
                  <label htmlFor={`admin-child-${index}-middle-initial`}>Middle Initial</label>
                  <input id={`admin-child-${index}-middle-initial`} className="sts-input" aria-label={`Child ${childNumber} middle initial`} maxLength={2} value={child.middleInitial} onChange={(event) => updateChild(index, { middleInitial: event.target.value })} />
                  <ErrorText>{rowErrors.middleInitial}</ErrorText>
                </div>
                <div className="form-group">
                  <label htmlFor={`admin-child-${index}-last-name`}>Last Name *</label>
                  <input id={`admin-child-${index}-last-name`} className="sts-input" aria-label={`Child ${childNumber} last name`} value={child.lastName} onChange={(event) => updateChild(index, { lastName: event.target.value })} />
                  <ErrorText>{rowErrors.lastName}</ErrorText>
                </div>
                <div className="form-group">
                  <label htmlFor={`admin-child-${index}-grade`}>Grade *</label>
                  <select id={`admin-child-${index}-grade`} className="sts-input" aria-label={`Child ${childNumber} grade`} value={child.gradeLevel} onChange={(event) => updateChild(index, { gradeLevel: event.target.value, section: '' })}>
                    <option value="">Select Grade</option>
                    {PARENT_CHILD_GRADE_OPTIONS.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                  </select>
                  <ErrorText>{rowErrors.gradeLevel}</ErrorText>
                </div>
                <div className="form-group">
                  <label htmlFor={`admin-child-${index}-section`}>Section *</label>
                  <select id={`admin-child-${index}-section`} className="sts-input" aria-label={`Child ${childNumber} section`} value={child.section} disabled={!child.gradeLevel || sections.length === 0} onChange={(event) => updateChild(index, { section: event.target.value })}>
                    <option value="">Select Section</option>
                    {sections.map((section) => <option key={section} value={section}>{section}</option>)}
                  </select>
                  <ErrorText>{rowErrors.section}</ErrorText>
                </div>
              </>
            )}

            {child.operation === 'create' && (
              <p className="field-help">Student ID will be generated automatically from the school&rsquo;s existing sequence.</p>
            )}
            {child.operation !== 'create' && (
              <div className="form-group admin-parent-child-id">
                <label htmlFor={`admin-child-${index}-student-id`}>Student ID *</label>
                <input
                  id={`admin-child-${index}-student-id`}
                  className="sts-input"
                  aria-label={`Child ${childNumber} Student ID`}
                  inputMode="text"
                  maxLength={9}
                  placeholder={isExisting ? '17000087 or 17-000087' : '8 digits or legacy 6 digits'}
                  value={child.studentId}
                  onChange={(event) => updateChild(index, { studentId: event.target.value.replace(/[^0-9-]/g, '').slice(0, 9) })}
                  aria-invalid={eligibilityState.status === 'error' ? 'true' : undefined}
                  aria-describedby={eligibilityState.status === 'error' ? eligibilityErrorId : undefined}
                />
                <span className="field-help">
                  {isExisting
                    ? 'Enter the 8-digit school Student ID; the dash is optional.'
                    : 'Only Students without an active Parent relationship can be linked.'}
                </span>
                <ErrorText>{rowErrors.studentId}</ErrorText>
                {eligibilityState.status === 'pending' && <span className="field-help" role="status">Checking Student ID...</span>}
                {eligibilityState.status === 'valid' && <span className="field-help" role="status">Student ID is available.</span>}
                {eligibilityState.status === 'error' && <span id={eligibilityErrorId} className="error-text" role="alert">{eligibilityState.error}</span>}
              </div>
            )}
          </fieldset>
        );
      })}
    </section>
  );
}
