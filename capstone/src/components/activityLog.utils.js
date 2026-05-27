const toTimestamp = (value) => {
  const parsed = new Date(value || 0).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const normalizeRole = (role) => String(role || '').trim().toLowerCase();

export function shouldShowActivityLogFilters(role) {
  return normalizeRole(role) !== 'parent';
}

export function buildActivityLogQueryParams({
  limit = 50,
  itemsPerPage = 10,
  currentPage = 1,
  role = 'admin',
  userId = null,
  selectedStudentId = '',
  debouncedSearch = '',
  selectedGrade = '',
  selectedSection = '',
}) {
  const params = new URLSearchParams();
  params.append('limit', String(Math.min(limit, itemsPerPage)));
  params.append('offset', String((currentPage - 1) * itemsPerPage));

  if (normalizeRole(role) === 'teacher' && userId) {
    params.append('teacher_id', String(userId));
  }

  if (selectedStudentId) {
    params.append('student_id', String(selectedStudentId));
  }

  if (shouldShowActivityLogFilters(role)) {
    if (debouncedSearch) {
      params.append('search', debouncedSearch);
    }
    if (selectedGrade) {
      params.append('grade_level', selectedGrade);
    }
    if (selectedSection) {
      params.append('section', selectedSection);
    }
  }

  return params;
}

export function normalizeActivityLogPayload(payload) {
  const rawRecords = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const uniqueRecords = [];
  const seenIds = new Set();

  rawRecords.forEach((record) => {
    const key = record?.id ?? `${record?.student_id ?? 'unknown'}-${record?.activity_timestamp ?? record?.created_at ?? ''}`;
    if (seenIds.has(key)) return;
    seenIds.add(key);
    uniqueRecords.push(record);
  });

  uniqueRecords.sort((a, b) => {
    const left = toTimestamp(a?.activity_timestamp || a?.created_at || a?.last_played);
    const right = toTimestamp(b?.activity_timestamp || b?.created_at || b?.last_played);
    return right - left;
  });

  const pagination = payload?.pagination && typeof payload.pagination === 'object'
    ? payload.pagination
    : {
        total: uniqueRecords.length,
        pages: Math.max(1, Math.ceil(uniqueRecords.length / 10)),
        current_page: 1,
      };

  return {
    records: uniqueRecords,
    pagination: {
      total: Number(pagination.total ?? uniqueRecords.length) || uniqueRecords.length,
      pages: Number(pagination.pages ?? 1) || 1,
      current_page: Number(pagination.current_page ?? 1) || 1,
    }
  };
}

export function getActivityLogGrade(record) {
  return String(record?.grade || record?.grade_level || '').trim() || '-';
}

export function getActivityLogActivity(record) {
  const quest = String(record?.current_quest || '').trim();
  if (quest) return quest;

  const description = String(record?.activity_description || '').trim();
  if (description && !/^gameplay session$/i.test(description)) return description;

  return 'No active quest';
}

const parseDurationSeconds = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);

  const hours = text.match(/(\d+)\s*h/i);
  const minutes = text.match(/(\d+)\s*m/i);
  const seconds = text.match(/(\d+)\s*s/i);
  const total = (hours ? Number(hours[1]) * 3600 : 0)
    + (minutes ? Number(minutes[1]) * 60 : 0)
    + (seconds ? Number(seconds[1]) : 0);

  return total > 0 ? total : null;
};

export function formatActivityLogDuration(record) {
  const formatted = String(record?.duration || '').trim();
  if (formatted && !/^\d+$/.test(formatted)) return formatted;

  const seconds = parseDurationSeconds(
    record?.duration_seconds ?? record?.total_play_time ?? record?.duration
  );
  if (seconds === null) return '-';
  if (seconds < 60) return `${seconds}s`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}
