import React, { useState } from 'react';
import { apiUrl } from '../api';
import { buildAuthHeaders } from './session.utils';
import {
  PARENT_CHILD_GRADE_OPTIONS,
  getParentChildSectionOptions,
  validateChildProfile,
} from '../utils/validation.utils';

const initialForm = {
  firstName: '',
  lastName: '',
  middleInitial: '',
  gradeLevel: '',
  section: '',
  studentId: '',
};

export default function ParentAddChildModal({ onClose, onCreated }) {
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [requestError, setRequestError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const updateField = (field, value) => {
    const nextForm = { ...form, [field]: value };
    setForm(nextForm);
    if (touched[field]) {
      setErrors((current) => ({ ...current, [field]: validateChildProfile(nextForm)[field] }));
    }
  };

  const touchField = (field) => {
    setTouched((current) => ({ ...current, [field]: true }));
    setErrors((current) => ({ ...current, [field]: validateChildProfile(form)[field] }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = validateChildProfile(form);
    setTouched({ firstName: true, lastName: true, middleInitial: true, gradeLevel: true, section: true, studentId: true });
    setErrors(nextErrors);
    setRequestError('');
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const response = await fetch(apiUrl('/api/parent/children'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
        body: JSON.stringify({
          first_name: form.firstName.trim(),
          last_name: form.lastName.trim(),
          middle_initial: form.middleInitial.trim(),
          grade_level: form.gradeLevel,
          section: form.section.trim().replace(/\s+/g, ' '),
          student_id: form.studentId.trim(),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setRequestError(payload?.error || 'Unable to add child at this time.');
        return;
      }
      onCreated?.(payload.child);
      onClose?.();
    } catch (error) {
      setRequestError('Unable to connect. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="parent-add-child-overlay" role="presentation">
      <section className="parent-add-child-modal" role="dialog" aria-modal="true" aria-labelledby="add-child-title">
        <div className="parent-add-child-heading">
          <div>
            <h2 id="add-child-title">Add Child</h2>
            <p>Create a linked Game Student ID for your child. Your Parent ID is verified from your signed-in account.</p>
          </div>
          <button type="button" className="parent-add-child-close" onClick={onClose} aria-label="Close Add Child form">×</button>
        </div>

        <form className="parent-add-child-form" onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="child-first-name">First Name *</label>
            <input id="child-first-name" value={form.firstName} onChange={(event) => updateField('firstName', event.target.value)} onBlur={() => touchField('firstName')} aria-invalid={Boolean(errors.firstName)} />
            {errors.firstName && <span className="error-text" role="alert">{errors.firstName}</span>}
          </div>
          <div className="form-group">
            <label htmlFor="child-last-name">Last Name *</label>
            <input id="child-last-name" value={form.lastName} onChange={(event) => updateField('lastName', event.target.value)} onBlur={() => touchField('lastName')} aria-invalid={Boolean(errors.lastName)} />
            {errors.lastName && <span className="error-text" role="alert">{errors.lastName}</span>}
          </div>
          <div className="form-group">
            <label htmlFor="child-middle-initial">Middle Initial</label>
            <input id="child-middle-initial" value={form.middleInitial} onChange={(event) => updateField('middleInitial', event.target.value)} onBlur={() => touchField('middleInitial')} maxLength={2} aria-invalid={Boolean(errors.middleInitial)} />
            {errors.middleInitial && <span className="error-text" role="alert">{errors.middleInitial}</span>}
          </div>
          <div className="form-group">
            <label htmlFor="child-grade">Grade *</label>
            <select id="child-grade" value={form.gradeLevel} onChange={(event) => updateField('gradeLevel', event.target.value)} onBlur={() => touchField('gradeLevel')} aria-invalid={Boolean(errors.gradeLevel)}>
              <option value="">Select Grade</option>
              {PARENT_CHILD_GRADE_OPTIONS.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
            </select>
            {errors.gradeLevel && <span className="error-text" role="alert">{errors.gradeLevel}</span>}
          </div>
          <div className="form-group">
            <label htmlFor="child-section">Section</label>
            <input id="child-section" list="child-section-suggestions" value={form.section} onChange={(event) => updateField('section', event.target.value)} onBlur={() => touchField('section')} maxLength={50} aria-invalid={Boolean(errors.section)} placeholder="e.g. Rizal" />
            <datalist id="child-section-suggestions">
              {getParentChildSectionOptions(form.gradeLevel).map((section) => <option key={section} value={section} />)}
            </datalist>
            {errors.section && <span className="error-text" role="alert">{errors.section}</span>}
          </div>
          <div className="form-group parent-add-child-student-id">
            <label htmlFor="child-student-id">Student ID Number *</label>
            <input id="child-student-id" value={form.studentId} onChange={(event) => updateField('studentId', event.target.value)} onBlur={() => touchField('studentId')} inputMode="numeric" maxLength={6} placeholder="001234" aria-invalid={Boolean(errors.studentId)} />
            <span className="field-help">Use the six-digit Game Student ID. Leading zeroes are kept.</span>
            {errors.studentId && <span className="error-text" role="alert">{errors.studentId}</span>}
          </div>
          {requestError && <p className="parent-add-child-request-error" role="alert">{requestError}</p>}
          <div className="parent-add-child-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Adding...' : 'Add Child'}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
