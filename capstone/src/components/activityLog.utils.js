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
