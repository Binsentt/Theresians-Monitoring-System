import React, { useState } from 'react';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';

const RESET_REASONS = [
  'New Lesson',
  'Completed Current Lesson',
  'New Grading Period',
  'Testing Data Cleanup',
  'Other',
];

export const LearningCycleResetAction = ({ studentId, role, onReset, className = 'table-action-button table-reset-action' }) => {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    if (submitting) return;
    setOpen(false);
    setReason('');
    setCustomReason('');
    setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!reason) {
      setError('Select a reason for reset.');
      return;
    }
    if (reason === 'Other' && !customReason.trim()) {
      setError('Provide a reason for Other.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(
        buildScopedApiUrl(`/api/student-progress/${studentId}/reset`, role),
        {
          method: 'POST',
          headers: { ...buildAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, custom_reason: customReason.trim() }),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || 'Unable to start a new learning cycle.');
      setOpen(false);
      setReason('');
      setCustomReason('');
      onReset?.(payload);
    } catch (requestError) {
      setError(requestError.message || 'Unable to start a new learning cycle.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        Reset Progress
      </button>
      {open && (
        <div
          className="learning-cycle-reset-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <form
            className="learning-cycle-reset-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="learning-cycle-reset-title"
            onSubmit={submit}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="learning-cycle-reset-title">Start a New Learning Cycle</h2>
            <p>Current learning progress and analytics will restart for this student.</p>
            <p>Historical Screen Time, Activity Log, and gameplay results remain preserved.</p>
            <label htmlFor="learning-cycle-reason">Reason for Reset</label>
            <select
              id="learning-cycle-reason"
              name="learning-cycle-reason"
              value={reason}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                setReason(event.target.value);
                setError('');
              }}
              disabled={submitting}
            >
              <option value="">Select a reason</option>
              {RESET_REASONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            {reason === 'Other' && (
              <>
                <label htmlFor="learning-cycle-custom-reason">Custom reason</label>
                <textarea
                  id="learning-cycle-custom-reason"
                  value={customReason}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    setCustomReason(event.target.value);
                    setError('');
                  }}
                  maxLength={1000}
                  disabled={submitting}
                />
              </>
            )}
            {error && <p className="learning-cycle-reset-error" role="alert">{error}</p>}
            <div className="learning-cycle-reset-actions">
              <button type="button" className="secondary-button" onClick={close} disabled={submitting}>Cancel</button>
              <button type="submit" className="table-action-button" disabled={submitting}>
                {submitting ? 'Starting…' : 'Start New Learning Cycle'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
};
