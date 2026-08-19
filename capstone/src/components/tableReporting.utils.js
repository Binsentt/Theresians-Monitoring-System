const studentIdentifierField = (field) => /(^|_)(game_)?student_id$/i.test(String(field || ''));

const normalizeText = (value) => String(value ?? '').trim().toLowerCase();

export function matchesTableSearch(row, query, fields) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;

  return (Array.isArray(fields) ? fields : []).some((field) => {
    const value = normalizeText(row?.[field]);
    if (!value) return false;

    return studentIdentifierField(field)
      ? value === normalizedQuery
      : value.includes(normalizedQuery);
  });
}

export function paginateTableRows(rows, requestedPage = 1, pageSize = 10) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safePageSize = Math.max(1, Number(pageSize) || 10);
  const totalItems = safeRows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.min(Math.max(1, Number(requestedPage) || 1), totalPages);
  const startOffset = (currentPage - 1) * safePageSize;
  const start = totalItems === 0 ? 0 : startOffset + 1;
  const end = Math.min(startOffset + safePageSize, totalItems);

  return {
    rows: safeRows.slice(startOffset, startOffset + safePageSize),
    currentPage,
    totalPages,
    totalItems,
    start,
    end,
  };
}

export function formatTableRange({ totalItems = 0, start = 0, end = 0 } = {}) {
  if (!totalItems) return '0 records';
  return `Showing ${start}–${end} of ${totalItems} records`;
}
