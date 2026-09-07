const SCENE_DIFFICULTY_MAP = {
  oak_leaf_village: 'Easy',
  city_of_knowledge: 'Normal',
  pinehill_village: 'Difficult',
  player_house: 'Easy',
  players_house: 'Easy',
  teacher_house: 'Easy',
  player_house_outside_door: 'Easy',
  teacher_house_outside_door: 'Easy',
  npc_house_outside_door: 'Easy',
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

const resolveCurrentDifficulty = (payload = {}) => {
  const mapDifficulty = resolveDifficultyFromScene({ current_map: payload.current_map || payload.currentMap || payload.map || payload.map_name });
  if (mapDifficulty !== 'Unknown') return mapDifficulty;
  const sceneDifficulty = resolveDifficultyFromScene(payload);
  if (sceneDifficulty !== 'Unknown') return sceneDifficulty;
  const saved = String(payload.difficulty_level || payload.difficulty || '').trim().toLowerCase();
  if (saved === 'easy') return 'Easy';
  if (['normal', 'medium', 'average', 'normal / average'].includes(saved)) return 'Normal';
  if (['difficult', 'hard'].includes(saved)) return 'Difficult';
  return 'Unknown';
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
  resolveCurrentDifficulty,
  sortRowsByStudentName,
};
