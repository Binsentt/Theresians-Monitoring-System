const SCENE_DIFFICULTY_MAP = {
  oak_leaf_village: 'Easy',
  city_of_knowledge: 'Normal',
  pinehill_village: 'Difficult',
};

const VALID_PLAYTIME_STATUS_LABELS = {
  active: 'Active',
  playing: 'Playing',
  online: 'Online',
  offline: 'Offline',
  completed: 'Completed',
  timedout: 'Timed Out',
  interrupted: 'Interrupted',
  inprogress: 'In Progress',
};

const normalizeKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/\\/g, '/')
  .split('/')
  .filter(Boolean)
  .at(-1)
  ?.replace(/\?.*$/, '')
  .replace(/\.tscn$/i, '')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '') || '';

const resolveDifficultyFromScene = (payload = {}) => {
  const candidates = [
    payload.current_scene,
    payload.currentScene,
    payload.scene,
    payload.scene_name,
    payload.current_map,
    payload.currentMap,
    payload.map,
    payload.map_name,
  ];

  for (const candidate of candidates) {
    const key = normalizeKey(candidate);
    if (SCENE_DIFFICULTY_MAP[key]) {
      return SCENE_DIFFICULTY_MAP[key];
    }
  }

  return 'Unknown';
};

const normalizePlaytimeStatus = (status, fallback = 'Offline') => {
  const key = normalizeKey(status).replace(/_/g, '');
  if (key === 'autosave' || key === 'autosaved' || key === 'limitreached') return 'Completed';
  if (key === 'loggedout') return 'Offline';
  return VALID_PLAYTIME_STATUS_LABELS[key] || VALID_PLAYTIME_STATUS_LABELS[normalizeKey(fallback).replace(/_/g, '')] || 'Offline';
};

const getStudentDisplayName = (row = {}) => String(row.student_name || row.child_name || row.name || '').trim();

const sortRowsByStudentName = (rows) => {
  if (!Array.isArray(rows)) return [];
  return rows.slice().sort((left, right) => (
    getStudentDisplayName(left).localeCompare(getStudentDisplayName(right), undefined, {
      sensitivity: 'base',
      numeric: true,
    })
  ));
};

module.exports = {
  normalizePlaytimeStatus,
  resolveDifficultyFromScene,
  sortRowsByStudentName,
};
