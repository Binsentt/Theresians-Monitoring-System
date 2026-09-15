const schoolIdentifierField = (field) => /(^|_)(game_)?(student|parent|teacher|employee)_id$/i.test(String(field || ''));
const gradeField = (field) => /(^|_)(grade|grade_level)$/i.test(String(field || ''));
const difficultyField = (field) => /(^|_)(difficulty|difficulty_level)$/i.test(String(field || ''));

const normalizeText = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const normalizeSchoolIdentifier = (value) => {
  const text = String(value ?? '').trim();
  if (/^\d{2}-\d{6}$/.test(text)) return text.replace('-', '');
  return /^(?:\d{6}|\d{8})$/.test(text) ? text : null;
};

const normalizeGradeValue = (value) => {
  const text = normalizeText(value);
  const gradeFirst = text.match(/^grade\s*(\d{1,2})$/);
  const ordinalFirst = text.match(/^(\d{1,2})(?:st|nd|rd|th)\s+grade$/);
  const numericOnly = text.match(/^(\d{1,2})$/);
  const number = gradeFirst?.[1] || ordinalFirst?.[1] || numericOnly?.[1];
  return number ? `grade ${Number(number)}` : text;
};

const normalizeDifficultyValue = (value) => {
  const text = normalizeText(value);
  return text === 'hard' ? 'difficult' : text;
};

const extractStructuredSearch = (query) => {
  let remaining = normalizeText(query);
  let grade = null;
  let difficulty = null;

  const gradeMatch = remaining.match(/\bgrade\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+grade\b/);
  if (gradeMatch) {
    grade = `grade ${Number(gradeMatch[1] || gradeMatch[2])}`;
    remaining = normalizeText(`${remaining.slice(0, gradeMatch.index)} ${remaining.slice(gradeMatch.index + gradeMatch[0].length)}`);
  }

  const difficultyMatch = remaining.match(/\bdifficulty\s*(easy|normal|difficult|hard)\b/);
  if (difficultyMatch) {
    difficulty = normalizeDifficultyValue(difficultyMatch[1]);
    remaining = normalizeText(`${remaining.slice(0, difficultyMatch.index)} ${remaining.slice(difficultyMatch.index + difficultyMatch[0].length)}`);
  }

  return { grade, difficulty, terms: remaining.split(' ').filter(Boolean) };
};

export function matchesTableSearch(row, query, fields) {
  const search = extractStructuredSearch(query);
  if (!search.grade && !search.difficulty && search.terms.length === 0) return true;

  const values = (Array.isArray(fields) ? fields : [])
    .map((field) => ({
      field,
      value: normalizeText(row?.[field]),
      identifier: schoolIdentifierField(field) ? normalizeSchoolIdentifier(row?.[field]) : null,
    }))
    .filter(({ value }) => Boolean(value));

  if (search.grade && !values.some(({ field, value }) => gradeField(field) && normalizeGradeValue(value) === search.grade)) {
    return false;
  }
  if (search.difficulty && !values.some(({ field, value }) => (
    difficultyField(field) && normalizeDifficultyValue(value) === search.difficulty
  ))) {
    return false;
  }

  return search.terms.every((term) => {
    const canonicalIdentifier = normalizeSchoolIdentifier(term);
    if (canonicalIdentifier) {
      return values.some(({ field, identifier }) => schoolIdentifierField(field) && identifier === canonicalIdentifier);
    }
    return values.some(({ field, value }) => (
      schoolIdentifierField(field) ? value === term : value.includes(term)
    ));
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
