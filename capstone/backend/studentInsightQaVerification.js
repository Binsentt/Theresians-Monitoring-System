const fs = require('node:fs');
const path = require('node:path');

const QA_ARTIFACT_SCHEMA_VERSION = 1;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;

const ARTIFACT_FIELDS = new Set([
  'providerCallStartedAt',
  'providerCallFinishedAt',
  'httpStatus',
  'requestId',
  'errorType',
  'errorCode',
  'elapsedMs',
  'providerCallCount',
  'generationSuccess',
  'persistenceSuccess',
  'cacheCheckPerformed',
  'cacheHit',
  'providerHttpStatus',
  'responseExtractionStage',
  'outputTextPresent',
  'nestedOutputContentTextPresent',
  'outputItemCount',
  'textContentItemCount',
  'jsonParseSucceeded',
  'validationStage',
  'topLevelKeys',
  'claimCounts',
  'unknownClaimCount',
  'duplicateClaimCount',
  'unsupportedClaimCount',
  'renderedOutputValidation',
  'persistenceSucceeded',
  'finishedAt',
]);

const toIsoTimestamp = (value) => {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const safeCode = (value, pattern = SAFE_CODE_PATTERN) => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return pattern.test(text) ? text : null;
};

const safeHttpStatus = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
};

const safeElapsedMs = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};

const safeCount = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
};

const safeKeyList = (value) => (Array.isArray(value)
  ? value.filter((item) => /^[A-Za-z0-9_.-]{1,80}$/.test(String(item))).slice(0, 30)
  : []);

const safeClaimCounts = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  return {
    performance: safeCount(source.performance),
    strengths: safeCount(source.strengths),
    weaknesses: safeCount(source.weaknesses),
    recommendations: safeCount(source.recommendations),
    trends: safeCount(source.trends),
  };
};

const insightDiagnosticsPatch = (value = {}) => {
  const diagnostics = value?.analytics || value?.insightDiagnostics || value || {};
  const patch = {};
  const copySafeCode = (key) => {
    if (diagnostics[key] !== undefined) patch[key] = safeCode(diagnostics[key]);
  };
  const copyBoolean = (key) => {
    if (typeof diagnostics[key] === 'boolean') patch[key] = diagnostics[key];
  };
  const copyCount = (key) => {
    if (diagnostics[key] !== undefined) patch[key] = safeCount(diagnostics[key]);
  };
  if (diagnostics.providerHttpStatus !== undefined) patch.providerHttpStatus = safeHttpStatus(diagnostics.providerHttpStatus);
  copySafeCode('responseExtractionStage');
  copyBoolean('outputTextPresent');
  copyBoolean('nestedOutputContentTextPresent');
  copyCount('outputItemCount');
  copyCount('textContentItemCount');
  copyBoolean('jsonParseSucceeded');
  copySafeCode('validationStage');
  if (diagnostics.topLevelKeys !== undefined) patch.topLevelKeys = safeKeyList(diagnostics.topLevelKeys);
  if (diagnostics.claimCounts !== undefined) patch.claimCounts = safeClaimCounts(diagnostics.claimCounts);
  copyCount('unknownClaimCount');
  copyCount('duplicateClaimCount');
  copyCount('unsupportedClaimCount');
  copyBoolean('renderedOutputValidation');
  copyBoolean('persistenceSucceeded');
  return patch;
};

const diagnosticPatch = (value = {}) => {
  const diagnostics = value?.providerDiagnostics || value?.diagnostics || value || {};
  const patch = {};
  const httpStatus = diagnostics.httpStatus ?? diagnostics.http_status ?? diagnostics.status;
  const requestId = diagnostics.requestId ?? diagnostics.request_id;
  const errorType = diagnostics.errorType ?? diagnostics.error_type;
  const errorCode = diagnostics.errorCode ?? diagnostics.error_code ?? value?.code;
  if (httpStatus !== undefined) patch.httpStatus = safeHttpStatus(httpStatus);
  if (requestId !== undefined) patch.requestId = safeCode(requestId, REQUEST_ID_PATTERN);
  if (errorType !== undefined) patch.errorType = safeCode(errorType);
  if (errorCode !== undefined) patch.errorCode = safeCode(errorCode);
  if (diagnostics.elapsedMs !== undefined) patch.elapsedMs = safeElapsedMs(diagnostics.elapsedMs);
  Object.assign(patch, insightDiagnosticsPatch(diagnostics));
  return patch;
};

const sanitizePatch = (patch = {}) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!ARTIFACT_FIELDS.has(key)) continue;
    if (key.endsWith('At')) {
      sanitized[key] = toIsoTimestamp(value);
    } else if (key === 'httpStatus') {
      sanitized[key] = safeHttpStatus(value);
    } else if (key === 'providerHttpStatus') {
      sanitized[key] = safeHttpStatus(value);
    } else if (key === 'responseExtractionStage' || key === 'validationStage') {
      sanitized[key] = safeCode(value);
    } else if (['outputItemCount', 'textContentItemCount', 'unknownClaimCount', 'duplicateClaimCount', 'unsupportedClaimCount'].includes(key)) {
      sanitized[key] = safeCount(value);
    } else if (key === 'requestId') {
      sanitized[key] = safeCode(value, REQUEST_ID_PATTERN);
    } else if (key === 'errorType' || key === 'errorCode') {
      sanitized[key] = safeCode(value);
    } else if (key === 'elapsedMs') {
      sanitized[key] = safeElapsedMs(value);
    } else if (key === 'providerCallCount') {
      sanitized[key] = safeCount(value);
    } else if (key === 'topLevelKeys') {
      sanitized[key] = safeKeyList(value);
    } else if (key === 'claimCounts') {
      sanitized[key] = safeClaimCounts(value);
    } else if (typeof value === 'boolean') {
      sanitized[key] = value;
    }
  }
  return sanitized;
};

const safeIdentity = (value) => {
  const text = String(value || '').trim();
  return text && /^[A-Za-z0-9_.:-]{1,160}$/.test(text) ? text : null;
};

const createInsightQaResultWriter = ({
  filePath,
  testRunId,
  candidateSha,
  now = () => new Date().toISOString(),
  fsImpl = fs.promises,
} = {}) => {
  if (!filePath || typeof filePath !== 'string') throw new TypeError('filePath is required.');
  const identity = safeIdentity(testRunId) || 'student-insight-qa';
  const initialCandidateSha = /^[a-f0-9]{40}$/i.test(String(candidateSha || ''))
    ? String(candidateSha).toLowerCase()
    : null;
  const state = {
    schemaVersion: QA_ARTIFACT_SCHEMA_VERSION,
    testRunId: identity,
    candidateSha: initialCandidateSha,
    startedAt: toIsoTimestamp(now()),
    providerCallStartedAt: null,
    providerCallFinishedAt: null,
    httpStatus: null,
    requestId: null,
    errorType: null,
    errorCode: null,
    elapsedMs: null,
    providerCallCount: 0,
    generationSuccess: null,
    persistenceSuccess: null,
    cacheCheckPerformed: false,
    cacheHit: false,
    providerHttpStatus: null,
    responseExtractionStage: null,
    outputTextPresent: null,
    nestedOutputContentTextPresent: null,
    outputItemCount: null,
    textContentItemCount: null,
    jsonParseSucceeded: null,
    validationStage: null,
    topLevelKeys: [],
    claimCounts: { performance: 0, strengths: 0, weaknesses: 0, recommendations: 0, trends: 0 },
    unknownClaimCount: 0,
    duplicateClaimCount: 0,
    unsupportedClaimCount: 0,
    renderedOutputValidation: null,
    persistenceSucceeded: null,
    finishedAt: null,
  };

  const tempPath = `${filePath}.tmp`;
  let providerStartedMs = null;

  const writeAtomically = async () => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    await fsImpl.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try {
      await fsImpl.rename(tempPath, filePath);
    } catch (error) {
      // Windows does not replace an existing destination with rename. The
      // fallback keeps every completed milestone durable while remaining
      // scoped to this disposable QA artifact.
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      try {
        await fsImpl.unlink(filePath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
      await fsImpl.rename(tempPath, filePath);
    }
    return { ...state };
  };

  const update = async (patch = {}) => {
    Object.assign(state, sanitizePatch(patch));
    return writeAtomically();
  };

  return {
    filePath,
    async update(patch) {
      return update(patch);
    },
    async read() {
      try {
        return JSON.parse(await fsImpl.readFile(filePath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    async flush() {
      return writeAtomically();
    },
    async markProviderCallStarted({ at = now() } = {}) {
      state.providerCallCount += 1;
      providerStartedMs = Date.now();
      return update({
        providerCallStartedAt: at,
        providerCallFinishedAt: null,
      });
    },
    async markProviderCallFinished(details = {}) {
      const elapsedMs = details?.elapsedMs ?? (providerStartedMs === null ? null : Date.now() - providerStartedMs);
      providerStartedMs = null;
      return update({
        ...diagnosticPatch(details),
        ...(elapsedMs === null ? {} : { elapsedMs }),
        providerCallFinishedAt: details?.finishedAt || now(),
      });
    },
    async markGeneration(success) {
      return update({ generationSuccess: success === null ? null : Boolean(success) });
    },
    async markPersistence(success) {
      return update({ persistenceSuccess: success === null ? null : Boolean(success) });
    },
    async markCache({ performed = true, hit = false } = {}) {
      return update({ cacheCheckPerformed: Boolean(performed), cacheHit: Boolean(hit) });
    },
    async recordInsightDiagnostics(diagnostics = {}) {
      return update(insightDiagnosticsPatch(diagnostics));
    },
    async finish(patch = {}) {
      return update({ ...patch, finishedAt: patch.finishedAt || now() });
    },
    async clearProviderCall() {
      state.providerCallCount = Math.max(0, state.providerCallCount - 1);
      providerStartedMs = null;
      return update({
        providerCallCount: state.providerCallCount,
        providerCallStartedAt: null,
        providerCallFinishedAt: null,
      });
    },
    async recordProviderCall({ execute, onProviderCallStart, onProviderCallFinish } = {}) {
      if (typeof execute !== 'function') throw new TypeError('execute must be a function.');
      await this.markProviderCallStarted();
      if (typeof onProviderCallStart === 'function') {
        await onProviderCallStart({ resultWriter: this });
      }
      try {
        const result = await execute();
        await this.markProviderCallFinished(result);
        if (typeof onProviderCallFinish === 'function') {
          await onProviderCallFinish({ result, resultWriter: this });
        }
        return result;
      } catch (error) {
        await this.markProviderCallFinished(error);
        if (typeof onProviderCallFinish === 'function') {
          await onProviderCallFinish({ error, resultWriter: this });
        }
        throw error;
      }
    },
    async cleanup() {
      for (const candidate of [filePath, tempPath]) {
        try {
          await fsImpl.unlink(candidate);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    },
  };
};

async function runInsightCacheVerification({
  request,
  resolveInsight,
  resultWriter,
  onProviderCallStart,
  onProviderCallFinish,
  onInsightDiagnostics,
} = {}) {
  if (typeof resolveInsight !== 'function') throw new TypeError('resolveInsight must be a function.');
  const insightDiagnosticsHandler = typeof onInsightDiagnostics === 'function'
    ? onInsightDiagnostics
    : resultWriter && typeof resultWriter.recordInsightDiagnostics === 'function'
      ? (diagnostics) => resultWriter.recordInsightDiagnostics(diagnostics)
      : null;

  const resolveInitial = resultWriter && typeof resultWriter.recordProviderCall === 'function'
    ? () => resultWriter.recordProviderCall({
      execute: () => resolveInsight(request, { onInsightDiagnostics: insightDiagnosticsHandler }),
      onProviderCallStart,
      onProviderCallFinish,
    })
    : () => resolveInsight(request, { onInsightDiagnostics: insightDiagnosticsHandler });

  let first;
  try {
    first = await resolveInitial();
  } catch (error) {
    if (resultWriter) {
      await resultWriter.markGeneration(false);
      await resultWriter.markPersistence(false);
      await resultWriter.markCache({ performed: false, hit: false });
      await resultWriter.finish();
    }
    throw error;
  }

  const generated = ['generated', 'regenerated'].includes(first?.status);
  const providerFailed = first?.status === 'unavailable';
  if (!generated) {
    if (resultWriter) {
      if (first?.status === 'cached' || first?.status === 'paused' || first?.status === 'no_data') {
        await resultWriter.clearProviderCall();
      }
      await resultWriter.markGeneration(providerFailed ? false : null);
      await resultWriter.markPersistence(providerFailed ? false : null);
      await resultWriter.markCache({ performed: false, hit: false });
      await resultWriter.finish();
    }
    return {
      first,
      second: null,
      cacheVerification: 'skipped',
    };
  }

  if (resultWriter) {
    await resultWriter.markGeneration(true);
    await resultWriter.markPersistence(true);
    await resultWriter.markCache({ performed: true, hit: false });
  }

  let second;
  try {
    second = await resolveInsight(request, { onInsightDiagnostics: insightDiagnosticsHandler });
  } catch (error) {
    if (resultWriter) {
      await resultWriter.markCache({ performed: true, hit: false });
      await resultWriter.finish();
    }
    throw error;
  }
  const cacheVerification = second?.status === 'cached' ? 'hit' : 'miss';
  if (resultWriter) {
    await resultWriter.markCache({ performed: true, hit: cacheVerification === 'hit' });
    await resultWriter.finish();
  }
  return {
    first,
    second,
    cacheVerification,
  };
}

module.exports = {
  QA_ARTIFACT_SCHEMA_VERSION,
  createInsightQaResultWriter,
  diagnosticPatch,
  runInsightCacheVerification,
};
