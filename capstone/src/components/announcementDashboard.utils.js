export function getAnnouncementUserId(user) {
  const value = user?.id ?? user?.user_id ?? user?.account_id;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function getAnnouncementUserName(user, fallback = 'User') {
  return user?.name || user?.full_name || user?.email || fallback;
}

export function isAnnouncementStatusError(message) {
  return /failed|error|connection|please|unable|not found/i.test(String(message || ''));
}

export function updateAnnouncementCollection(items, announcement) {
  const list = Array.isArray(items) ? items : [];
  if (!announcement?.id) return list;

  const exists = list.some((item) => item.id === announcement.id);
  if (!exists) {
    return [announcement, ...list];
  }

  return list.map((item) => (item.id === announcement.id ? announcement : item));
}

export function removeAnnouncementFromCollection(items, announcementId) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((item) => item.id !== announcementId);
}
