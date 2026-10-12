const asPositiveInteger = (value, fallback = 1) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

export function paginateReportRows(rows, rowHeights, availableHeight) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (sourceRows.length === 0) return [[]];

  const safeAvailableHeight = Math.max(1, Number(availableHeight) || 1);
  const pages = [];
  let currentRows = [];
  let currentHeight = 0;

  sourceRows.forEach((row, index) => {
    const measuredHeight = Number(rowHeights?.[index]);
    const rowHeight = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : 1;

    if (currentRows.length && currentHeight + rowHeight > safeAvailableHeight) {
      pages.push(currentRows);
      currentRows = [];
      currentHeight = 0;
    }

    currentRows.push(row);
    currentHeight += rowHeight;
  });

  if (currentRows.length) pages.push(currentRows);
  return pages.length ? pages : [[]];
}

export function parseReportPageSelection(mode, customRange, totalPages) {
  const pageCount = Math.max(1, Math.floor(Number(totalPages) || 1));
  const allPages = Array.from({ length: pageCount }, (_, index) => index + 1);
  if (mode === 'all') return { pages: allPages, error: '' };
  if (mode === 'odd') return { pages: allPages.filter((page) => page % 2 === 1), error: '' };
  if (mode === 'even') return { pages: allPages.filter((page) => page % 2 === 0), error: '' };
  if (mode !== 'custom') return { pages: [], error: 'Choose a valid page selection.' };

  const value = String(customRange ?? '').trim();
  const invalidRangeMessage = `Enter page numbers or ranges from 1 through ${pageCount}, for example 1, 3, 5 or 1-3, 6, 8-10.`;
  if (!value || !/^\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*$/.test(value)) {
    return { pages: [], error: invalidRangeMessage };
  }

  const pages = new Set();
  const tokens = value.split(',').map((token) => token.trim());
  for (const token of tokens) {
    const [firstValue, lastValue = firstValue] = token.split('-').map((part) => Number(part.trim()));
    if (
      !Number.isInteger(firstValue)
      || !Number.isInteger(lastValue)
      || firstValue < 1
      || lastValue < firstValue
      || lastValue > pageCount
    ) {
      return { pages: [], error: invalidRangeMessage };
    }
    for (let page = firstValue; page <= lastValue; page += 1) pages.add(page);
  }

  return { pages: Array.from(pages).sort((left, right) => left - right), error: '' };
}

export function composeReportSheets(pages, pagesPerSheet) {
  const sourcePages = Array.isArray(pages) ? pages : [];
  const count = [1, 2, 4].includes(Number(pagesPerSheet))
    ? asPositiveInteger(pagesPerSheet)
    : 1;
  const sheets = [];
  for (let index = 0; index < sourcePages.length; index += count) {
    sheets.push(sourcePages.slice(index, index + count));
  }
  return sheets;
}
