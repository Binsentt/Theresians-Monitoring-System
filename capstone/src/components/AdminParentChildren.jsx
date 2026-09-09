import React from 'react';
import { getSectionsForGrade } from '../sectionRegistry';
import { PARENT_CHILD_GRADE_OPTIONS } from '../utils/validation.utils';
import { createAdminChildDraft } from './adminParentChildren.utils';

const ErrorText = ({ children }) => children ? <span className="error-text" role="alert">{children}</span> : null;

export default function AdminParentChildren({ value = [], onChange, sectionRegistry, errors = [], formError = '' }) {
  const children = Array.isArray(value) ? value : [];
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
        <button type="button" className="sts-add-btn" data-action="add-child" onClick={addChild}>Add Another Child</button>
      </div>
      {formError && <p className="error-text" role="alert">{formError}</p>}

      {children.map((child, index) => {
        const rowErrors = errors[index] || {};
        const childNumber = index + 1;
        const isLink = child.operation === 'link';
        const sections = getSectionsForGrade(sectionRegistry, child.gradeLevel);
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
                onChange={(event) => updateChild(index, { operation: event.target.value })}
              >
                <option value="create">Create New Student</option>
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

            <div className="form-group admin-parent-child-id">
              <label htmlFor={`admin-child-${index}-student-id`}>Student ID *</label>
              <input
                id={`admin-child-${index}-student-id`}
                className="sts-input"
                aria-label={`Child ${childNumber} Student ID`}
                inputMode="numeric"
                maxLength={8}
                placeholder={isLink ? '6 or 8 digits' : '8 digits'}
                value={child.studentId}
                onChange={(event) => updateChild(index, { studentId: event.target.value.replace(/\D/g, '').slice(0, 8) })}
              />
              <span className="field-help">
                {isLink
                  ? 'Only Students without an active Parent relationship can be linked.'
                  : 'New Student IDs must be exactly 8 digits. Leading zeroes are kept.'}
              </span>
              <ErrorText>{rowErrors.studentId}</ErrorText>
            </div>
          </fieldset>
        );
      })}
    </section>
  );
}
