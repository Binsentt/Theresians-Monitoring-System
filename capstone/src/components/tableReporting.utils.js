const schoolIdentifierField = (field) => /(^|_)(game_)?(student|parent|teacher|employee)_id$/i.test(String(field || ''));

const normalizeText = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function matchesTableSearch(row, query, fields) {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  if (terms.length === 0) return true;

  const values = (Array.isArray(fields) ? fields : [])
    .map((field) => ({ field, value: normalizeText(row?.[field]) }))
    .filter(({ value }) => Boolean(value));

  return terms.every((term) => values.some(({ field, value }) => (
    schoolIdentifierField(field) ? value === term : value.includes(term)
  )));
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

export function formatReportContext({ scope = '', recordCount = 0 } = {}) {
  const normalizedScope = String(scope || '').trim();
  const count = Math.max(0, Number(recordCount) || 0);
  return `${normalizedScope ? `${normalizedScope} · ` : ''}Records: ${count}`;
}

export async function collectAuthorizedReportRows({ loadPage, pageSize = 100 }) {
  if (typeof loadPage !== 'function') return [];

  const limit = Math.min(Math.max(1, Number(pageSize) || 100), 200);
  const rows = [];
  let page = 1;
  let totalPages = 1;

  do {
    const payload = await loadPage({ page, limit });
    const pageRows = Array.isArray(payload?.rows) ? payload.rows : [];
    rows.push(...pageRows);
    const reportedPages = Number(payload?.pagination?.pages);
    totalPages = Number.isFinite(reportedPages) && reportedPages > 0
      ? reportedPages
      : pageRows.length === limit
        ? page + 1
        : page;
    page += 1;
  } while (page <= totalPages);

  return rows;
}
