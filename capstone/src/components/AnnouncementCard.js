import React from 'react';

function formatAnnouncementDate(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getRoleLabel(role, fallback) {
  const normalizedRole = String(role || fallback || 'School').trim();
  return normalizedRole.charAt(0).toUpperCase() + normalizedRole.slice(1).toLowerCase();
}

export function AnnouncementCard({
  announcement,
  fallbackAuthor = 'School',
  highlight = false,
  onEdit,
  onDelete,
  actionDisabled = false,
}) {
  const roleLabel = getRoleLabel(announcement.created_by_role, fallbackAuthor);
  const roleClass = roleLabel.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const canManage = Boolean(onEdit || onDelete);

  return (
    <article className={`announcement-card ${highlight ? 'announcement-card-latest' : ''}`}>
      <div className="announcement-card-icon" aria-hidden="true">
        {roleLabel.charAt(0)}
      </div>
      <div className="announcement-card-body">
        <div className="announcement-card-meta-row">
          <span className={`announcement-role-badge announcement-role-${roleClass}`}>
            {roleLabel}
          </span>
          {highlight && <span className="announcement-latest-badge">Latest</span>}
          <time className="announcement-date" dateTime={announcement.created_at || undefined}>
            {formatAnnouncementDate(announcement.created_at)}
          </time>
        </div>
        <h3 className="announcement-card-title">{announcement.title}</h3>
        <p className="announcement-card-message">{announcement.message}</p>
        {canManage && (
          <div className="announcement-card-actions" aria-label="Announcement actions">
            {onEdit && (
              <button
                type="button"
                className="announcement-card-action announcement-edit-action"
                onClick={() => onEdit(announcement)}
                disabled={actionDisabled}
              >
                Edit
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className="announcement-card-action announcement-delete-action"
                onClick={() => onDelete(announcement)}
                disabled={actionDisabled}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function AnnouncementEmptyState({ title, message }) {
  return (
    <div className="announcement-empty-state">
      <div className="announcement-empty-icon" aria-hidden="true">i</div>
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}
