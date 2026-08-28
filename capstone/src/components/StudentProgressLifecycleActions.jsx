import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';

const ARCHIVE_REASONS = [
  'Graduated',
  'End of School Year',
  'Transferred',
  'No Longer Enrolled',
  'Testing Data Cleanup',
  'Other',
];

const stopModalEvent = (event) => event.stopPropagation();

const requestJson = async (path, role, body) => {
  const response = await fetch(buildScopedApiUrl(path, role), {
    method: 'POST',
    headers: { ...buildAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || 'Unable to update Student progress.');
  return payload;
};

const LifecycleDialog = ({ children, onClose, className = '' }) => createPortal(
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
      className={`learning-cycle-reset-dialog ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      onPointerDown={stopModalEvent}
      onMouseDown={stopModalEvent}
      onClick={stopModalEvent}
      onChange={stopModalEvent}
    >
      {children}
    </div>
  </div>,
  document.body,
);

export const StudentProgressArchiveAction = ({ studentId, role, onComplete, className = 'table-action-button table-archive-action' }) => {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const close = (force = false) => {
    if (submitting && !force) return;
    setOpen(false);
    setReason('');
    setCustomReason('');
    setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!reason) return setError('Select a reason for archive.');
    if (reason === 'Other' && !customReason.trim()) return setError('Provide a reason for Other.');
    setSubmitting(true);
    setError('');
    try {
      const payload = await requestJson(`/api/student-progress/${studentId}/archive`, role, {
        reason,
        custom_reason: customReason.trim(),
      });
      close(true);
      onComplete?.(payload);
    } catch (requestError) {
      setError(requestError.message || 'Unable to archive Student progress.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button type="button" className={className} onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={(event) => { event.stopPropagation(); setOpen(true); }}>
        Delete
      </button>
      {open && (
        <LifecycleDialog onClose={close}>
          <form onSubmit={submit} onPointerDown={stopModalEvent} onClick={stopModalEvent}>
            <h2>Delete Student Progress</h2>
            <p><strong>Action type: Archive / Remove from Active Progress</strong></p>
            <p>This removes the student from Active Progress views. Historical gameplay, Screen Time, and Activity Log remain preserved.</p>
            <label htmlFor={`archive-reason-${studentId}`}>Reason for Delete</label>
            <select
              id={`archive-reason-${studentId}`}
              name="archive-reason"
              value={reason}
              onPointerDown={stopModalEvent}
              onMouseDown={stopModalEvent}
              onClick={stopModalEvent}
              onChange={(event) => { setReason(event.target.value); setError(''); }}
              disabled={submitting}
            >
              <option value="">Select a reason</option>
              {ARCHIVE_REASONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            {reason === 'Other' && (
              <>
                <label htmlFor={`archive-custom-reason-${studentId}`}>Custom reason</label>
                <textarea
                  id={`archive-custom-reason-${studentId}`}
                  value={customReason}
                  onPointerDown={stopModalEvent}
                  onMouseDown={stopModalEvent}
                  onClick={stopModalEvent}
                  onChange={(event) => { setCustomReason(event.target.value); setError(''); }}
                  maxLength={1000}
                  disabled={submitting}
                />
              </>
            )}
            {error && <p className="learning-cycle-reset-error" role="alert">{error}</p>}
            <div className="learning-cycle-reset-actions">
              <button type="button" className="secondary-button" onClick={close} disabled={submitting}>Cancel</button>
              <button type="submit" className="table-action-button" disabled={submitting}>{submitting ? 'Removing…' : 'Delete (Archive)'}</button>
            </div>
          </form>
        </LifecycleDialog>
      )}
    </>
  );
};

export const StudentProgressPermanentDeleteAction = ({ studentId, onComplete, className = 'table-action-button table-permanent-delete-action' }) => {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const close = (force = false) => {
    if (submitting && !force) return;
    setOpen(false); setReason(''); setConfirmation(''); setError('');
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!reason.trim()) return setError('Provide a deletion reason.');
    if (confirmation !== 'DELETE') return setError('Type DELETE to confirm.');
    setSubmitting(true); setError('');
    try {
      const payload = await requestJson(`/api/student-progress/${studentId}/permanent-delete`, 'admin', {
        reason: reason.trim(),
        confirmation_phrase: confirmation,
      });
      close(true);
      onComplete?.(payload);
    } catch (requestError) {
      setError(requestError.message || 'Unable to permanently delete gameplay progress.');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <>
      <button type="button" className={className} onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={(event) => { event.stopPropagation(); setOpen(true); }}>Permanent Delete</button>
      {open && (
        <LifecycleDialog onClose={close} className="learning-cycle-permanent-delete-dialog">
          <form onSubmit={submit} onPointerDown={stopModalEvent} onClick={stopModalEvent}>
            <h2>Permanently Delete Gameplay Progress</h2>
            <p>This deletes only current and historical gameplay/progress-derived data. Screen Time, activity history, accounts, and relationships remain preserved.</p>
            <label htmlFor={`permanent-delete-reason-${studentId}`}>Required reason</label>
            <textarea id={`permanent-delete-reason-${studentId}`} value={reason} onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={stopModalEvent} onChange={(event) => { setReason(event.target.value); setError(''); }} maxLength={1000} disabled={submitting} />
            <label htmlFor={`permanent-delete-confirmation-${studentId}`}>Type DELETE to confirm</label>
            <input id={`permanent-delete-confirmation-${studentId}`} value={confirmation} onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={stopModalEvent} onChange={(event) => { setConfirmation(event.target.value); setError(''); }} disabled={submitting} autoComplete="off" />
            {error && <p className="learning-cycle-reset-error" role="alert">{error}</p>}
            <div className="learning-cycle-reset-actions">
              <button type="button" className="secondary-button" onClick={close} disabled={submitting}>Cancel</button>
              <button type="submit" className="table-action-button table-permanent-delete-action" disabled={submitting}>{submitting ? 'Deleting…' : 'Delete Gameplay Data'}</button>
            </div>
          </form>
        </LifecycleDialog>
      )}
    </>
  );
};

export const BulkStudentProgressLifecycleAction = ({ operation, role, onComplete, label: labelOverride, warning: warningOverride }) => {
  const [open, setOpen] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [affectedCount, setAffectedCount] = useState(null);
  const [reason, setReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isArchive = operation === 'archive';
  const label = labelOverride || (isArchive ? 'Delete All' : 'Reset All');
  const requiredPhrase = isArchive ? 'ARCHIVE' : 'RESET';
  const reasons = isArchive ? ARCHIVE_REASONS : ['New Lesson', 'Completed Current Lesson', 'New Grading Period', 'Testing Data Cleanup', 'Other'];

  const close = (force = false) => {
    if (submitting && !force) return;
    setOpen(false); setAffectedCount(null); setReason(''); setCustomReason(''); setConfirmation(''); setError('');
  };
  const openDialog = async (event) => {
    event.stopPropagation();
    setOpen(true); setSummaryLoading(true); setError('');
    try {
      const response = await fetch(buildScopedApiUrl(`/api/student-progress/lifecycle-summary?operation=${operation}`, role), { headers: buildAuthHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || 'Unable to prepare the lifecycle action.');
      setAffectedCount(Number(payload.affected_count || 0));
    } catch (requestError) {
      setError(requestError.message || 'Unable to prepare the lifecycle action.');
    } finally {
      setSummaryLoading(false);
    }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!reason) return setError(`Select a reason for ${isArchive ? 'archive' : 'reset'}.`);
    if (reason === 'Other' && !customReason.trim()) return setError('Provide a reason for Other.');
    if (confirmation !== requiredPhrase) return setError(`Type ${requiredPhrase} to confirm.`);
    if (affectedCount === null) return setError('Wait for the affected-student count before confirming.');
    setSubmitting(true); setError('');
    try {
      const payload = await requestJson(`/api/student-progress/bulk/${operation}`, role, {
        reason,
        custom_reason: customReason.trim(),
        expected_count: affectedCount,
      confirmation,
      });
      close(true); onComplete?.(payload);
    } catch (requestError) {
      setError(requestError.message || `Unable to ${operation} authorized Student progress.`);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <>
      <button type="button" className="table-action-button" onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={openDialog}>{label}</button>
      {open && (
        <LifecycleDialog onClose={close}>
          <form onSubmit={submit} onPointerDown={stopModalEvent} onClick={stopModalEvent}>
            <h2>{label}</h2>
            <p>{warningOverride || (isArchive ? 'Delete all currently authorized active Students by moving them to Archived Progress. Historical records remain preserved. New Lesson is not an archive reason.' : 'Start a fresh learning cycle for all currently authorized active Students.')}</p>
            <p><strong>{summaryLoading ? 'Preparing affected count…' : `${affectedCount ?? 0} Students will be affected.`}</strong></p>
            <label htmlFor={`bulk-${operation}-reason`}>Reason</label>
            <select id={`bulk-${operation}-reason`} name={`bulk-${operation}-reason`} value={reason} onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={stopModalEvent} onChange={(event) => { setReason(event.target.value); setError(''); }} disabled={submitting || summaryLoading}>
              <option value="">Select a reason</option>
              {reasons.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            {reason === 'Other' && <textarea aria-label="Custom reason" value={customReason} onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={stopModalEvent} onChange={(event) => { setCustomReason(event.target.value); setError(''); }} maxLength={1000} disabled={submitting} />}
            <label htmlFor={`bulk-${operation}-confirmation`}>Type {requiredPhrase} to confirm</label>
            <input id={`bulk-${operation}-confirmation`} value={confirmation} onPointerDown={stopModalEvent} onMouseDown={stopModalEvent} onClick={stopModalEvent} onChange={(event) => { setConfirmation(event.target.value); setError(''); }} disabled={submitting || summaryLoading} autoComplete="off" />
            {error && <p className="learning-cycle-reset-error" role="alert">{error}</p>}
            <div className="learning-cycle-reset-actions">
              <button type="button" className="secondary-button" onClick={close} disabled={submitting}>Cancel</button>
              <button type="submit" className="table-action-button" disabled={submitting || summaryLoading || affectedCount === null}>{submitting ? 'Saving…' : label}</button>
            </div>
          </form>
        </LifecycleDialog>
      )}
    </>
  );
};
