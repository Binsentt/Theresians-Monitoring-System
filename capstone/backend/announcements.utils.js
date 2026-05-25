const normalizeAnnouncementRole = (role) => {
  const value = String(role || '').trim().toLowerCase();
  return value === 'admin' || value === 'teacher' ? value : null;
};

const normalizeAnnouncementTarget = (role) => {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'teacher' || value === 'teachers') return 'teacher';
  if (value === 'parent' || value === 'parents') return 'parent';
  return null;
};

const normalizeAnnouncementPayload = (payload = {}) => {
  const title = String(payload.title || '').trim();
  const message = String(payload.message || '').trim();
  const createdBy = Number.parseInt(payload.created_by, 10);
  const createdByRole = normalizeAnnouncementRole(payload.created_by_role);
  const targetRole = normalizeAnnouncementTarget(payload.target_role);

  if (!title || !message || Number.isNaN(createdBy) || !createdByRole || !targetRole) {
    return null;
  }

  return { title, message, createdBy, createdByRole, targetRole };
};

const normalizeAnnouncementManagementPayload = (payload = {}) => {
  const title = String(payload.title || '').trim();
  const message = String(payload.message || '').trim();
  const actorId = Number.parseInt(payload.actor_id ?? payload.created_by, 10);
  const actorRole = normalizeAnnouncementRole(payload.actor_role ?? payload.created_by_role);

  if (!title || !message || Number.isNaN(actorId) || !actorRole) {
    return null;
  }

  return { title, message, actorId, actorRole };
};

const normalizeAnnouncementActorPayload = (payload = {}) => {
  const actorId = Number.parseInt(payload.actor_id ?? payload.created_by, 10);
  const actorRole = normalizeAnnouncementRole(payload.actor_role ?? payload.created_by_role);

  if (Number.isNaN(actorId) || !actorRole) {
    return null;
  }

  return { actorId, actorRole };
};

const canManageAnnouncement = (announcement = {}, actor = {}) => {
  const announcementCreator = Number.parseInt(announcement.created_by, 10);
  const announcementRole = normalizeAnnouncementRole(announcement.created_by_role);
  const actorId = Number.parseInt(actor.actorId ?? actor.actor_id, 10);
  const actorRole = normalizeAnnouncementRole(actor.actorRole ?? actor.actor_role);

  return !Number.isNaN(announcementCreator) &&
    !Number.isNaN(actorId) &&
    announcementCreator === actorId &&
    announcementRole === actorRole;
};

const buildAnnouncementSchemaRepairStatements = () => [
  'ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS title VARCHAR(150)',
  'ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS message TEXT',
  'ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL',
  'ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS created_by_role VARCHAR(50)',
  'ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS target_role VARCHAR(50)',
  'ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP',
];

module.exports = {
  buildAnnouncementSchemaRepairStatements,
  normalizeAnnouncementRole,
  normalizeAnnouncementTarget,
  normalizeAnnouncementPayload,
  normalizeAnnouncementManagementPayload,
  normalizeAnnouncementActorPayload,
  canManageAnnouncement,
};
