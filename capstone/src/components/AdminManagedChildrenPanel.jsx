import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../api';
import AdminParentChildren from './AdminParentChildren';
import {
  createAdminChildDraft,
  toAdminParentChildrenPayload,
  validateAdminParentChildren,
} from './adminParentChildren.utils';
import { matchesTableSearch, paginateTableRows } from './tableReporting.utils';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';

const emptyDrafts = () => [createAdminChildDraft()];

export default function AdminManagedChildrenPanel({ parentId, sectionRegistry, authHeaders = {} }) {
  const [children, setChildren] = useState([]);
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [draftErrors, setDraftErrors] = useState([]);
  const [formError, setFormError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [pending, setPending] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [removalReason, setRemovalReason] = useState('');
  const [draftValidation, setDraftValidation] = useState({ pending: false, isValid: false });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const filteredChildren = useMemo(() => children.filter((child) => matchesTableSearch(
    child,
    searchQuery,
    ['student_name', 'game_student_id', 'grade_level', 'section']
  )), [children, searchQuery]);
  const paginatedChildren = paginateTableRows(filteredChildren, page, 10);
  const printColumns = [
    { header: 'Student Name', value: (row) => row.student_name || 'Unknown' },
    { header: 'Student ID', value: (row) => row.game_student_id || 'Not linked' },
    { header: 'Grade', value: (row) => row.grade_level || 'Not assigned' },
    { header: 'Section', value: (row) => row.section || 'Not assigned' },
  ];

  useEffect(() => {
    if (page !== paginatedChildren.currentPage) setPage(paginatedChildren.currentPage);
  }, [page, paginatedChildren.currentPage]);

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
    const reason = removalReason.trim();
    if (!pending || !reason || (permanent && confirmation !== 'DELETE')) return;
    setBusy(true);
    try {
      const response = await fetch(apiUrl(`/api/accounts/${parentId}/children/${pending.student_id}${permanent ? '?permanent=true' : ''}`), {
        method: 'DELETE',
        headers: requestHeaders,
        body: JSON.stringify(permanent ? { permanent_confirmation: confirmation, reason } : { reason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Unable to update this child.');
      setMessage(permanent ? 'Student account permanently deleted.' : 'Child unlinked; Student account preserved.');
      setPending(null);
      setConfirmation('');
      setRemovalReason('');
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
        <button type="button" className="sts-add-btn semantic-action-add" onClick={() => setShowAdd((value) => !value)}>
          {showAdd ? 'Cancel Add Child' : 'Add Child'}
        </button>
      </div>

      {showAdd && (
        <div className="admin-managed-children-add">
          <AdminParentChildren
            value={drafts}
            onChange={setDrafts}
            sectionRegistry={sectionRegistry}
            errors={draftErrors}
            formError={formError}
            authHeaders={authHeaders}
            onValidationStateChange={setDraftValidation}
          />
          <button type="button" className="update-btn semantic-action-add" disabled={busy || draftValidation.pending || !draftValidation.isValid} onClick={addChildren}>Save Children</button>
        </div>
      )}
      {message && <p className="info-text" role="status">{message}</p>}

      <div className="table-report-controls no-print">
        <label>
          Search children
          <input
            type="search"
            value={searchQuery}
            placeholder="Search name, Student ID, grade, or section..."
            onChange={(event) => { setSearchQuery(event.target.value); setPage(1); }}
          />
        </label>
        <TablePrintButton reportTitle="Parent Children" label="Print Children" showPrintHeading={false} />
      </div>

      {filteredChildren.length === 0 ? <p className="empty-table-msg">{children.length ? 'No children match this search.' : 'No linked children yet.'}</p> : (
        <div className="table-container">
          <table className="sts-data-table" aria-label="Managed Parent children">
            <thead><tr><th>STUDENT NAME</th><th>STUDENT ID</th><th>GRADE</th><th>SECTION</th><th>ACTION</th></tr></thead>
            <tbody>
              {paginatedChildren.rows.map((child) => (
                <tr key={child.student_id}>
                  <td>{child.student_name || 'Unknown'}</td>
                  <td>{child.game_student_id || 'Not linked'}</td>
                  <td>{child.grade_level || 'Not assigned'}</td>
                  <td>{child.section || 'Not assigned'}</td>
                  <td className="managed-child-action-cell">
                    <div className="managed-child-action-group">
                      <button type="button" className="delete-action-btn semantic-action-amber" data-action="unlink-child" onClick={() => { setPending({ ...child, operation: 'unlink' }); setConfirmation(''); setRemovalReason(''); }}>Remove Child</button>
                      <button type="button" className="delete-action-btn" data-action="delete-student-permanently" onClick={() => { setPending({ ...child, operation: 'permanent' }); setConfirmation(''); setRemovalReason(''); }}>Delete Student Permanently</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination-row no-print" aria-label="Parent children pagination">
        <span>{paginatedChildren.totalItems === 0 ? '0 records' : `Showing ${paginatedChildren.start} - ${paginatedChildren.end} of ${paginatedChildren.totalItems} records`}</span>
        <button type="button" disabled={paginatedChildren.currentPage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
        <span>Page {paginatedChildren.currentPage} of {paginatedChildren.totalPages}</span>
        <button type="button" disabled={paginatedChildren.currentPage === paginatedChildren.totalPages} onClick={() => setPage((current) => Math.min(paginatedChildren.totalPages, current + 1))}>Next</button>
      </div>
      <PrintableTableReport title="Parent Children" context={searchQuery ? `Search: ${searchQuery}` : 'All linked children'} rows={filteredChildren} columns={printColumns} />

      {pending?.operation === 'unlink' && (
        <div className="managed-child-confirmation" role="dialog" aria-modal="true" aria-label="Confirm Remove Child">
          <h4>Remove Child</h4>
          <p>Remove the Parent relationship for <strong>{pending.student_name}</strong> (Student ID {pending.game_student_id})?</p>
          <p className="managed-child-confirmation-detail">Parent account: {parentId}. Affected data: this relationship only. The Student account and gameplay data will be preserved, including Screen Time and activity history.</p>
          <label htmlFor="managed-child-unlink-reason">Reason *</label>
          <textarea id="managed-child-unlink-reason" aria-label="Reason for removing this child relationship" value={removalReason} onChange={(event) => setRemovalReason(event.target.value)} maxLength={500} />
          <button type="button" onClick={() => { setPending(null); setRemovalReason(''); }}>Cancel</button>
          <button type="button" data-action="confirm-unlink-child" disabled={busy || !removalReason.trim()} onClick={() => removeChild(false)}>Confirm Remove Child</button>
        </div>
      )}
      {pending?.operation === 'permanent' && (
        <div className="managed-child-confirmation" role="dialog" aria-modal="true" aria-label="Confirm permanent Student deletion">
          <h4>Delete Student Permanently</h4>
          <p>This action is irreversible and deletes the Student account and its dependent gameplay records. Type DELETE to continue.</p>
          <p><strong>{pending.student_name}</strong> — Student ID {pending.game_student_id}</p>
          <p className="managed-child-confirmation-detail">Parent account: {parentId}. Affected data: Student account, gameplay/progress records, and derived insights. Sibling Students and the Parent account are not affected.</p>
          <label htmlFor="managed-child-delete-reason">Reason *</label>
          <textarea id="managed-child-delete-reason" aria-label="Reason for permanently deleting this Student account" value={removalReason} onChange={(event) => setRemovalReason(event.target.value)} maxLength={500} />
          <input aria-label="Type DELETE to confirm Student deletion" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          <button type="button" onClick={() => { setPending(null); setConfirmation(''); setRemovalReason(''); }}>Cancel</button>
          <button type="button" data-action="confirm-delete-student" disabled={busy || confirmation !== 'DELETE' || !removalReason.trim()} onClick={() => removeChild(true)}>Delete Student Permanently</button>
        </div>
      )}
    </section>
  );
}
