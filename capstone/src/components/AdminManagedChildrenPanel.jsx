import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';
import AdminParentChildren from './AdminParentChildren';
import {
  createAdminChildDraft,
  toAdminParentChildrenPayload,
  validateAdminParentChildren,
} from './adminParentChildren.utils';

const emptyDrafts = () => [createAdminChildDraft()];

export default function AdminManagedChildrenPanel({ parentId, sectionRegistry, authHeaders = {} }) {
  const [children, setChildren] = useState([]);
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [draftErrors, setDraftErrors] = useState([]);
  const [formError, setFormError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [pending, setPending] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const requestHeaders = { 'Content-Type': 'application/json', ...authHeaders };
  const loadChildren = useCallback(async () => {
    if (!parentId) return;
    const response = await fetch(apiUrl(`/api/accounts/${parentId}/children`), { headers: authHeaders });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to load children.');
    setChildren(Array.isArray(payload.children) ? payload.children : []);
  }, [parentId]); // authHeaders are stable values supplied by the authenticated Admin screen.

  useEffect(() => {
    let active = true;
    loadChildren().catch((error) => {
      if (active) setMessage(error.message);
    });
    return () => { active = false; };
  }, [loadChildren]);

  const addChildren = async () => {
    const validation = validateAdminParentChildren(drafts, sectionRegistry);
    setDraftErrors(validation.errors);
    setFormError(validation.formError);
    if (!validation.isValid) return;
    setBusy(true);
    try {
      const response = await fetch(apiUrl(`/api/accounts/${parentId}/children`), {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ children: toAdminParentChildrenPayload(drafts) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Unable to add children.');
      setMessage('Children added successfully.');
      setDrafts(emptyDrafts());
      setDraftErrors([]);
      setFormError('');
      setShowAdd(false);
      await loadChildren();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const removeChild = async (permanent) => {
    if (!pending || (permanent && confirmation !== 'DELETE')) return;
    setBusy(true);
    try {
      const response = await fetch(apiUrl(`/api/accounts/${parentId}/children/${pending.student_id}${permanent ? '?permanent=true' : ''}`), {
        method: 'DELETE',
        headers: requestHeaders,
        body: JSON.stringify(permanent ? { permanent_confirmation: confirmation } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Unable to update this child.');
      setMessage(permanent ? 'Student account permanently deleted.' : 'Child unlinked; Student account preserved.');
      setPending(null);
      setConfirmation('');
      await loadChildren();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="form-container-card edit-user-teacher-panel admin-managed-children">
      <div className="admin-parent-children-heading">
        <div>
          <h3>Children ({children.length})</h3>
          <p className="edit-user-helper-text">Manage this Parent’s authoritative child relationships.</p>
        </div>
        <button type="button" className="sts-add-btn" onClick={() => setShowAdd((value) => !value)}>
          {showAdd ? 'Cancel Add Child' : 'Add Child'}
        </button>
      </div>

      {showAdd && (
        <div className="admin-managed-children-add">
          <AdminParentChildren value={drafts} onChange={setDrafts} sectionRegistry={sectionRegistry} errors={draftErrors} formError={formError} />
          <button type="button" className="update-btn" disabled={busy} onClick={addChildren}>Save Children</button>
        </div>
      )}
      {message && <p className="info-text" role="status">{message}</p>}

      {children.length === 0 ? <p className="empty-table-msg">No linked children yet.</p> : (
        <div className="table-container">
          <table className="sts-data-table" aria-label="Managed Parent children">
            <thead><tr><th>STUDENT NAME</th><th>STUDENT ID</th><th>GRADE</th><th>SECTION</th><th>ACTION</th></tr></thead>
            <tbody>
              {children.map((child) => (
                <tr key={child.student_id}>
                  <td>{child.student_name || 'Unknown'}</td>
                  <td>{child.game_student_id || 'Not linked'}</td>
                  <td>{child.grade_level || 'Not assigned'}</td>
                  <td>{child.section || 'Not assigned'}</td>
                  <td>
                    <button type="button" className="delete-action-btn" data-action="unlink-child" onClick={() => { setPending({ ...child, operation: 'unlink' }); setConfirmation(''); }}>Remove Child</button>
                    <button type="button" className="delete-action-btn" data-action="delete-student-permanently" onClick={() => { setPending({ ...child, operation: 'permanent' }); setConfirmation(''); }}>Delete Student Permanently</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending?.operation === 'unlink' && (
        <div className="managed-child-confirmation" role="dialog" aria-modal="true" aria-label="Confirm Remove Child">
          <h4>Remove Child</h4>
          <p>Remove the Parent relationship for <strong>{pending.student_name}</strong>? The Student account and gameplay data will be preserved.</p>
          <button type="button" onClick={() => setPending(null)}>Cancel</button>
          <button type="button" data-action="confirm-unlink-child" disabled={busy} onClick={() => removeChild(false)}>Confirm Remove Child</button>
        </div>
      )}
      {pending?.operation === 'permanent' && (
        <div className="managed-child-confirmation" role="dialog" aria-modal="true" aria-label="Confirm permanent Student deletion">
          <h4>Delete Student Permanently</h4>
          <p>This action is irreversible and deletes the Student account and dependent gameplay records. Type DELETE to continue.</p>
          <input aria-label="Type DELETE to confirm Student deletion" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          <button type="button" onClick={() => { setPending(null); setConfirmation(''); }}>Cancel</button>
          <button type="button" data-action="confirm-delete-student" disabled={busy || confirmation !== 'DELETE'} onClick={() => removeChild(true)}>Delete Student Permanently</button>
        </div>
      )}
    </section>
  );
}
