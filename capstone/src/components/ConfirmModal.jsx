import React from 'react';
import ModalPortal from './ModalPortal';
import '../styles/confirmModal.css';

export default function ConfirmModal({
  open,
  title = 'Confirm',
  message = '',
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  variant = 'default',
  busy = false,
  onConfirm,
  onCancel,
}) {
  if (!open) return null;

  const handleCancel = () => {
    if (!busy) onCancel?.();
  };

  return (
    <ModalPortal onClose={handleCancel}>
      <div className="confirm-modal-overlay" role="presentation" onMouseDown={handleCancel}>
        <div
          className={`confirm-modal confirm-modal-${variant}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-modal-title"
          aria-describedby="confirm-modal-message"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <h2 id="confirm-modal-title">{title}</h2>
          <p id="confirm-modal-message">{message}</p>
          <div className="confirm-modal-actions">
            <button type="button" className="confirm-modal-cancel" onClick={handleCancel} disabled={busy}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={`confirm-modal-confirm ${variant === 'danger' ? 'danger' : ''}`}
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? 'Please wait...' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
