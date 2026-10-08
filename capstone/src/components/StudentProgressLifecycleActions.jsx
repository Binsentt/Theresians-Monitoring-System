import React, { useState } from 'react';
import ModalPortal from './ModalPortal';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';

const RESET_REASONS = ['New Lesson', 'Completed Current Lesson', 'New Grading Period', 'Testing Data Cleanup', 'Other'];
const stopModalEvent = (event) => event.stopPropagation();

const requestJson = async (path, role, body) => {
  const response = await fetch(buildScopedApiUrl(path, role), {
    method: 'POST',
    headers: { ...buildAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || 'Unable to reset Student progress.');
  return payload;
};

const LifecycleDialog = ({ children, onClose }) => (
  <ModalPortal onClose={onClose}>
    <div
      className="learning-cycle-reset-overlay"
      onPointerDown={(event) => {
        stopModalEvent(event);
        if (event.target === event.currentTarget) onClose();
      }}
      onMouseDown={stopModalEvent}
      onClick={(event) => {
        stopModalEvent(event);
        if (event.target === event.currentTarget) onClose();
      }}
      onChange={stopModalEvent}
      onSubmit={stopModalEvent}
    >
      <div
        className="learning-cycle-reset-dialog"
        role="dialog"
        aria-modal="true"
        onPointerDown={stopModalEvent}
        onMouseDown={stopModalEvent}
        onClick={stopModalEvent}
        onChange={stopModalEvent}
      >
        {children}
      </div>
    </div>
  </ModalPortal>
);

export const StudentProgressResetAction = ({ role, onComplete, label: labelOverride, warning: warningOverride }) => {
  const [open, setOpen] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [affectedCount, setAffectedCount] = useState(null);
  const [reason, setReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const label = labelOverride || 'Reset All';

  const close = (force = false) => {
    if (submitting && !force) return;
    setOpen(false);
    setAffectedCount(null);
    setReason('');
    setCustomReason('');
    setConfirmation('');
    setError('');
  };

  const openDialog = async (event) => {
    event.stopPropagation();
    setOpen(true);
    setSummaryLoading(true);
    setError('');
    try {
      const response = await fetch(buildScopedApiUrl('/api/student-progress/lifecycle-summary?operation=reset', role), {
        headers: buildAuthHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || 'Unable to prepare the reset.');
      setAffectedCount(Number(payload.affected_count || 0));
    } catch (requestError) {
      setError(requestError.message || 'Unable to prepare the reset.');
    } finally {
      setSummaryLoading(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!reason) return setError('Select a reason for reset.');
    if (reason === 'Other' && !customReason.trim()) return setError('Provide a reason for Other.');
    if (confirmation !== 'RESET') return setError('Type RESET to confirm.');
    if (affectedCount === null) return setError('Wait for the affected-student count before confirming.');
    setSubmitting(true);
    setError('');
    try {
      const payload = await requestJson('/api/student-progress/bulk/reset', role, {
        reason,
        custom_reason: customReason.trim(),
        expected_count: affectedCount,
        confirmation,
      });
      close(true);
      onComplete?.(payload);
    } catch (requestError) {
      setError(requestError.message || 'Unable to reset authorized Student progress.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button type="button" className="table-action-button table-reset-action" onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={openDialog}>
        {label}
      </button>
      {open && (
        <LifecycleDialog onClose={close}>
          <form onSubmit={submit} onPointerDown={stopModalEvent} onClick={stopModalEvent}>
            <h2>{label}</h2>
            <p>{warningOverride || 'Start a fresh learning cycle for all currently authorized active Students.'}</p>
            <p><strong>{summaryLoading ? 'Preparing affected count…' : `${affectedCount ?? 0} Students will be affected.`}</strong></p>
            <label htmlFor="bulk-reset-reason">Reason</label>
            <select
              id="bulk-reset-reason"
              name="bulk-reset-reason"
              value={reason}
              onPointerDown={stopModalEvent}
              onMouseDown={stopModalEvent}
              onClick={stopModalEvent}
              onChange={(event) => { setReason(event.target.value); setError(''); }}
              disabled={submitting || summaryLoading}
            >
              <option value="">Select a reason</option>
              {RESET_REASONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            {reason === 'Other' && (
              <textarea
                aria-label="Custom reason"
                value={customReason}
                onPointerDown={stopModalEvent}
                onMouseDown={stopModalEvent}
                onClick={stopModalEvent}
                onChange={(event) => { setCustomReason(event.target.value); setError(''); }}
                maxLength={1000}
                disabled={submitting}
              />
            )}
            <label htmlFor="bulk-reset-confirmation">Type RESET to confirm</label>
            <input
              id="bulk-reset-confirmation"
              value={confirmation}
              onPointerDown={stopModalEvent}
              onMouseDown={stopModalEvent}
              onClick={stopModalEvent}
              onChange={(event) => { setConfirmation(event.target.value); setError(''); }}
              disabled={submitting || summaryLoading}
              autoComplete="off"
            />
            {error && <p className="learning-cycle-reset-error" role="alert">{error}</p>}
            <div className="learning-cycle-reset-actions">
              <button type="button" className="secondary-button" onClick={close} disabled={submitting}>Cancel</button>
              <button type="submit" className="table-action-button table-reset-action" disabled={submitting || summaryLoading || affectedCount === null}>
                {submitting ? 'Saving…' : label}
              </button>
            </div>
          </form>
        </LifecycleDialog>
      )}
    </>
  );
};
