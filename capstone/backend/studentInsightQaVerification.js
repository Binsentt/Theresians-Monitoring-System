const fs = require('node:fs');
const path = require('node:path');

const QA_ARTIFACT_SCHEMA_VERSION = 1;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;
const QA_RUNNER_STATES = Object.freeze({
  INITIALIZED: 'INITIALIZED',
  READY: 'READY',
  PROVIDER_STARTED: 'PROVIDER_STARTED',
  PROVIDER_FINISHED: 'PROVIDER_FINISHED',
  FINISHED: 'FINISHED',
  INTERRUPTED: 'INTERRUPTED',
  BLOCKED: 'BLOCKED',
});

const createQaError = (code, message) => Object.assign(new Error(message), { code });

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
  'responseStatus',
  'incompleteReason',
  'incompleteCode',
  'outputItemTypes',
  'contentItemTypes',
  'refusalContentPresent',
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
  'runnerState',
  'artifactReady',
  'realProviderGate',
  'providerCallStarted',
  'lastKnownStage',
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
  copySafeCode('responseStatus');
  copySafeCode('incompleteReason');
  copySafeCode('incompleteCode');
  if (diagnostics.outputItemTypes !== undefined) patch.outputItemTypes = safeKeyList(diagnostics.outputItemTypes);
  if (diagnostics.contentItemTypes !== undefined) patch.contentItemTypes = safeKeyList(diagnostics.contentItemTypes);
  copyBoolean('refusalContentPresent');
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
    } else if (['responseExtractionStage', 'responseStatus', 'incompleteReason', 'incompleteCode', 'validationStage'].includes(key)) {
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
    } else if (key === 'outputItemTypes' || key === 'contentItemTypes') {
      sanitized[key] = safeKeyList(value);
    } else if (key === 'topLevelKeys') {
      sanitized[key] = safeKeyList(value);
    } else if (key === 'claimCounts') {
      sanitized[key] = safeClaimCounts(value);
    } else if (['runnerState', 'realProviderGate', 'lastKnownStage'].includes(key)) {
      sanitized[key] = safeCode(value);
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
    responseStatus: null,
    incompleteReason: null,
    incompleteCode: null,
    outputItemTypes: [],
    contentItemTypes: [],
    refusalContentPresent: false,
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
    runnerState: QA_RUNNER_STATES.INITIALIZED,
    artifactReady: false,
    realProviderGate: 'BLOCKED',
    providerCallStarted: false,
    lastKnownStage: 'INITIALIZED',
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

  const readArtifact = async () => {
    try {
      return JSON.parse(await fsImpl.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };

  const prepareProviderCallGate = async ({
    resultConsumerReady = true,
    parentRuntimeAdequate = true,
  } = {}) => {
    if (!resultConsumerReady || !parentRuntimeAdequate) {
      state.runnerState = QA_RUNNER_STATES.BLOCKED;
      state.artifactReady = false;
      state.realProviderGate = 'BLOCKED';
      state.lastKnownStage = 'REAL_PROVIDER_GATE_BLOCKED';
      await writeAtomically();
      return { ready: false, artifact: await readArtifact() };
    }

    try {
      await writeAtomically();
      const initialArtifact = await readArtifact();
      if (!initialArtifact || initialArtifact.testRunId !== identity) {
        throw createQaError('QA_ARTIFACT_NOT_READABLE', 'QA artifact was not readable after initialization.');
      }
      state.runnerState = QA_RUNNER_STATES.READY;
      state.artifactReady = true;
      state.realProviderGate = 'READY';
      state.lastKnownStage = 'ARTIFACT_READY';
      await writeAtomically();
      const readyArtifact = await readArtifact();
      if (!readyArtifact || readyArtifact.artifactReady !== true) {
        throw createQaError('QA_ARTIFACT_NOT_READABLE', 'QA artifact readiness could not be confirmed.');
      }
      return { ready: true, artifact: readyArtifact };
    } catch (error) {
      state.runnerState = QA_RUNNER_STATES.BLOCKED;
      state.artifactReady = false;
      state.realProviderGate = 'BLOCKED';
      state.lastKnownStage = 'ARTIFACT_INIT_FAILED';
      try { await writeAtomically(); } catch {}
      throw error;
    }
  };

  return {
    filePath,
    async update(patch) {
      return update(patch);
    },
    async read() {
      return readArtifact();
    },
    async flush() {
      return writeAtomically();
    },
    async prepareProviderCallGate(options) {
      return prepareProviderCallGate(options);
    },
    async markProviderCallStarted({ at = now() } = {}) {
      if (state.artifactReady !== true) {
        throw createQaError('QA_ARTIFACT_NOT_READY', 'Provider call is blocked until the QA artifact is initialized and read back.');
      }
      state.providerCallCount += 1;
      providerStartedMs = Date.now();
      state.runnerState = QA_RUNNER_STATES.PROVIDER_STARTED;
      state.realProviderGate = 'OPEN';
      state.providerCallStarted = true;
      state.lastKnownStage = 'PROVIDER_CALL_STARTED';
      return update({
        providerCallStartedAt: at,
        providerCallFinishedAt: null,
      });
    },
    async markProviderCallFinished(details = {}) {
      const elapsedMs = details?.elapsedMs ?? (providerStartedMs === null ? null : Date.now() - providerStartedMs);
      providerStartedMs = null;
      state.runnerState = QA_RUNNER_STATES.PROVIDER_FINISHED;
      state.providerCallStarted = false;
      state.realProviderGate = 'CLOSED';
      state.lastKnownStage = 'PROVIDER_CALL_FINISHED';
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
      const safeDiagnostics = insightDiagnosticsPatch(diagnostics);
      if (safeDiagnostics.validationStage) state.lastKnownStage = safeDiagnostics.validationStage;
      return update(insightDiagnosticsPatch(diagnostics));
    },
    async finish(patch = {}) {
      state.runnerState = QA_RUNNER_STATES.FINISHED;
      state.providerCallStarted = false;
      state.realProviderGate = 'CLOSED';
      if (!state.lastKnownStage || state.lastKnownStage === 'PROVIDER_CALL_FINISHED') state.lastKnownStage = 'FINISHED';
      return update({ ...patch, finishedAt: patch.finishedAt || now() });
    },
    async markInterrupted({ stage = 'INTERRUPTED' } = {}) {
      state.runnerState = QA_RUNNER_STATES.INTERRUPTED;
      state.realProviderGate = 'CLOSED';
      state.lastKnownStage = safeCode(stage) || 'INTERRUPTED';
      return update({ providerCallStarted: state.providerCallStarted });
    },
    async clearProviderCall() {
      state.providerCallCount = Math.max(0, state.providerCallCount - 1);
      providerStartedMs = null;
      state.providerCallStarted = false;
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
  if (resultWriter && typeof resultWriter.prepareProviderCallGate === 'function') {
    const gate = await resultWriter.prepareProviderCallGate();
    if (!gate?.ready) throw createQaError('REAL_PROVIDER_GATE_BLOCKED', 'Real provider call blocked because the QA result consumer is not ready.');
  }
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
  QA_RUNNER_STATES,
  createInsightQaResultWriter,
  createQaError,
  diagnosticPatch,
  runInsightCacheVerification,
};
