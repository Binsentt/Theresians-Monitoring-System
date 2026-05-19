import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import logoImage from '../assets/images/STS_Logo.png';
import { AnnouncementCard, AnnouncementEmptyState } from './AnnouncementCard';
import {
  getAnnouncementUserId,
  getAnnouncementUserName,
  isAnnouncementStatusError,
  removeAnnouncementFromCollection,
  updateAnnouncementCollection,
} from './announcementDashboard.utils';
import { canAccessRole, normalizeRole } from './manageUsers.utils';

const API_BASE = 'http://localhost:5000';

const pageConfig = {
  admin: {
    requiredRole: 'admin',
    sidebarRole: 'admin',
    activeItem: 'announcements',
    portalLabel: 'Admin Portal',
    heading: 'Announcements',
    subheading: 'Create and manage announcements for teacher accounts.',
    targetRole: 'teacher',
    creatorRole: 'admin',
    formTitle: 'Teacher Announcement',
    formHeading: 'Post an update for teachers',
    editHeading: 'Edit teacher announcement',
    formHelp: 'Share school reminders, lesson updates, or dashboard notices with teacher accounts.',
    messagePlaceholder: 'Write a message for teachers',
    buttonLabel: 'Post to Teachers',
    emptyTitle: 'No teacher announcements posted yet',
    emptyMessage: 'Announcements you post for teachers will appear here for editing or deletion.',
    listTitle: 'Manage Teacher Announcements',
    fallbackAuthor: 'Admin',
    icon: 'A',
  },
  teacher: {
    requiredRole: 'teacher',
    sidebarRole: 'teacher',
    activeItem: 'announcements',
    portalLabel: 'Teacher Portal',
    heading: 'Announcements',
    subheading: 'Review admin updates and post announcements for parent accounts.',
    targetRole: 'parent',
    creatorRole: 'teacher',
    formTitle: 'Parent Announcement',
    formHeading: 'Post an update for parents',
    editHeading: 'Edit parent announcement',
    formHelp: 'Keep families informed about new lessons, activities, reminders, and student support updates.',
    messagePlaceholder: 'Write a message for parents',
    buttonLabel: 'Post to Parents',
    emptyTitle: 'No parent announcements posted yet',
    emptyMessage: 'Announcements you post for parents will appear here for editing or deletion.',
    listTitle: 'Manage Parent Announcements',
    fallbackAuthor: 'Teacher',
    icon: 'T',
  },
  parent: {
    requiredRole: 'parent',
    sidebarRole: 'parent',
    activeItem: 'announcements',
    portalLabel: 'Parent Portal',
    heading: 'Announcements',
    subheading: 'Read the latest updates and reminders from teachers.',
    targetRole: 'parent',
    creatorRole: 'teacher',
    readOnly: true,
    emptyTitle: 'No teacher announcements yet',
    emptyMessage: "Updates from your child's teacher will appear here when available.",
    listTitle: 'Teacher Announcements',
    fallbackAuthor: 'Teacher',
  },
};

const buildDeleteUrl = (announcementId, actorId, actorRole) => {
  const url = new URL(`${API_BASE}/api/announcements/${announcementId}`);
  url.searchParams.set('actor_id', String(actorId));
  url.searchParams.set('actor_role', actorRole);
  return url.toString();
};

export default function AnnouncementPage({ mode = 'parent' }) {
  const navigate = useNavigate();
  const config = pageConfig[mode] || pageConfig.parent;
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [announcements, setAnnouncements] = useState([]);
  const [adminAnnouncements, setAdminAnnouncements] = useState([]);
  const [form, setForm] = useState({ title: '', message: '' });
  const [editingAnnouncement, setEditingAnnouncement] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const sessionRole = normalizeRole(user?.role);
  const sidebarRole = sessionRole === 'parent_teacher' ? 'parent_teacher' : config.sidebarRole;
  const statusType = isAnnouncementStatusError(status) ? 'error' : 'success';

  const actorId = useMemo(() => getAnnouncementUserId(user), [user]);

  const loadAnnouncements = async (accountId) => {
    try {
      if (mode === 'teacher') {
        const [adminResult, ownResult] = await Promise.allSettled([
          fetch(`${API_BASE}/api/announcements?target_role=teacher&limit=20`),
          fetch(`${API_BASE}/api/announcements?target_role=parent&created_by=${accountId}&created_by_role=teacher&limit=20`),
        ]);

        if (adminResult.status === 'fulfilled' && adminResult.value.ok) {
          const data = await adminResult.value.json();
          setAdminAnnouncements(Array.isArray(data) ? data : []);
        } else {
          setAdminAnnouncements([]);
        }

        if (ownResult.status === 'fulfilled' && ownResult.value.ok) {
          const data = await ownResult.value.json();
          setAnnouncements(Array.isArray(data) ? data : []);
        } else {
          setAnnouncements([]);
        }
        return;
      }

      const query = config.readOnly
        ? `${API_BASE}/api/announcements?target_role=${config.targetRole}&limit=20`
        : `${API_BASE}/api/announcements?target_role=${config.targetRole}&created_by=${accountId}&created_by_role=${config.creatorRole}&limit=20`;
      const response = await fetch(query);
      if (response.ok) {
        const data = await response.json();
        setAnnouncements(Array.isArray(data) ? data : []);
      } else {
        setAnnouncements([]);
      }
    } catch (err) {
      console.error('Failed to load announcements:', err);
      setStatus('Failed to load announcements.');
      setAnnouncements([]);
      setAdminAnnouncements([]);
    }
  };

  useEffect(() => {
    const loadPage = async () => {
      try {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const stored = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
        const role = normalizeRole(stored?.role);
        const hasAccess = mode === 'parent' ? role === 'parent' : canAccessRole(role, config.requiredRole);
        if (!stored?.id || !hasAccess) {
          navigate('/login');
          return;
        }

        setUser({ ...stored, role });
        await loadAnnouncements(stored.id);
      } catch (err) {
        console.error('Announcement page load failed:', err);
        navigate('/login');
      } finally {
        setLoading(false);
      }
    };

    loadPage();
  }, [config.requiredRole, navigate]);

  const resetComposer = () => {
    setForm({ title: '', message: '' });
    setEditingAnnouncement(null);
    setStatus('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.title.trim() || !form.message.trim() || !actorId) {
      setStatus('Please enter a title and message before posting.');
      return;
    }

    setSaving(true);
    setStatus('');
    try {
      const isEditing = Boolean(editingAnnouncement?.id);
      const response = await fetch(isEditing ? `${API_BASE}/api/announcements/${editingAnnouncement.id}` : `${API_BASE}/api/announcements`, {
        method: isEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          message: form.message,
          created_by: actorId,
          created_by_role: config.creatorRole,
          actor_id: actorId,
          actor_role: config.creatorRole,
          target_role: config.targetRole,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error || (isEditing ? 'Failed to update announcement.' : 'Failed to post announcement.'));
        return;
      }

      setAnnouncements((prev) => updateAnnouncementCollection(prev, data));
      setForm({ title: '', message: '' });
      setEditingAnnouncement(null);
      setStatus(isEditing ? 'Announcement updated.' : `Announcement posted to ${config.targetRole === 'teacher' ? 'teachers' : 'parents'}.`);
    } catch (err) {
      setStatus('Connection error while saving announcement.');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (announcement) => {
    setEditingAnnouncement(announcement);
    setForm({ title: announcement.title || '', message: announcement.message || '' });
    setStatus('');
  };

  const handleDelete = async (announcement) => {
    if (!actorId || !announcement?.id) return;
    if (!window.confirm('Delete this announcement permanently?')) return;

    setSaving(true);
    setStatus('');
    try {
      const response = await fetch(buildDeleteUrl(announcement.id, actorId, config.creatorRole), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor_id: actorId, actor_role: config.creatorRole }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error || 'Failed to delete announcement.');
        return;
      }

      setAnnouncements((prev) => removeAnnouncementFromCollection(prev, announcement.id));
      if (editingAnnouncement?.id === announcement.id) {
        resetComposer();
      } else {
        setStatus('Announcement deleted.');
      }
    } catch (err) {
      setStatus('Connection error while deleting announcement.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="sts-loader-container">
        <div className="sts-spinner"></div>
        <p>Loading announcements...</p>
      </div>
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role={sidebarRole}
          activeItem={config.activeItem}
          logoSrc={logoImage}
          portalLabel={config.portalLabel}
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>{config.heading}</h1>
              <p>{config.subheading}</p>
            </div>
          </TopBar>

          <PageContent>
            {mode === 'teacher' && (
              <ContentSection title="Admin Announcements">
                {adminAnnouncements.length === 0 ? (
                  <AnnouncementEmptyState
                    title="No admin announcements yet"
                    message="New school-wide updates from the admin office will appear here."
                  />
                ) : (
                  <div className="announcement-list">
                    {adminAnnouncements.map((announcement, index) => (
                      <AnnouncementCard
                        key={announcement.id}
                        announcement={announcement}
                        fallbackAuthor="Admin"
                        highlight={index === 0}
                      />
                    ))}
                  </div>
                )}
              </ContentSection>
            )}

            {!config.readOnly && (
              <ContentSection title={config.formTitle}>
                <form className="announcement-form announcement-composer" onSubmit={handleSubmit}>
                  <div className="announcement-composer-header">
                    <div className="announcement-composer-icon" aria-hidden="true">{config.icon}</div>
                    <div>
                      <h3>{editingAnnouncement ? config.editHeading : config.formHeading}</h3>
                      <p>{editingAnnouncement ? 'Update the announcement title or message and save the changes.' : config.formHelp}</p>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Title</label>
                    <input
                      type="text"
                      className="input-field"
                      value={form.title}
                      onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                      placeholder="Announcement title"
                      maxLength={150}
                    />
                  </div>
                  <div className="form-group">
                    <label>Message</label>
                    <textarea
                      className="textarea-field"
                      value={form.message}
                      onChange={(event) => setForm((prev) => ({ ...prev, message: event.target.value }))}
                      placeholder={config.messagePlaceholder}
                      rows={4}
                    />
                  </div>
                  <div className="announcement-actions">
                    <button type="submit" className="btn-primary announcement-submit" disabled={saving}>
                      {saving ? 'Saving...' : editingAnnouncement ? 'Save Changes' : config.buttonLabel}
                    </button>
                    {editingAnnouncement && (
                      <button type="button" className="btn-secondary announcement-submit" onClick={resetComposer} disabled={saving}>
                        Cancel Edit
                      </button>
                    )}
                    {status && (
                      <span className={`announcement-status announcement-status-${statusType}`} aria-live="polite">
                        {status}
                      </span>
                    )}
                  </div>
                </form>
              </ContentSection>
            )}

            <ContentSection title={config.listTitle}>
              {config.readOnly && status && (
                <div className={`announcement-status announcement-status-${statusType}`} aria-live="polite">
                  {status}
                </div>
              )}
              {announcements.length === 0 ? (
                <AnnouncementEmptyState
                  title={config.emptyTitle}
                  message={config.emptyMessage}
                />
              ) : (
                <div className="announcement-list">
                  {announcements.map((announcement, index) => (
                    <AnnouncementCard
                      key={announcement.id}
                      announcement={announcement}
                      fallbackAuthor={getAnnouncementUserName(user, config.fallbackAuthor)}
                      highlight={index === 0}
                      onEdit={!config.readOnly ? handleEdit : undefined}
                      onDelete={!config.readOnly ? handleDelete : undefined}
                      actionDisabled={saving}
                    />
                  ))}
                </div>
              )}
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
