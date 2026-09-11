async function runInsightCacheVerification({ request, resolveInsight } = {}) {
  if (typeof resolveInsight !== 'function') throw new TypeError('resolveInsight must be a function.');
  const first = await resolveInsight(request);
  if (!['generated', 'regenerated'].includes(first?.status)) {
    return {
      first,
      second: null,
      cacheVerification: 'skipped',
    };
  }
  const second = await resolveInsight(request);
  return {
    first,
    second,
    cacheVerification: second?.status === 'cached' ? 'hit' : 'miss',
  };
}

module.exports = { runInsightCacheVerification };
