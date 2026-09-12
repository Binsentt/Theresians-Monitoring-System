const {
  createInsightQaResultWriter,
  createQaError,
} = require('./studentInsightQaVerification');

const runInsightQaInProcess = async ({
  filePath,
  testRunId,
  candidateSha,
  execute,
  consumeArtifact,
  now,
  fsImpl,
  resultConsumerReady = true,
  parentRuntimeAdequate = true,
} = {}) => {
  if (typeof execute !== 'function') throw new TypeError('execute must be a function.');
  const writer = createInsightQaResultWriter({ filePath, testRunId, candidateSha, now, fsImpl });
  let result = null;
  let error = null;
  let artifact = null;
  try {
    let gate;
    try {
      gate = await writer.prepareProviderCallGate({ resultConsumerReady, parentRuntimeAdequate });
      if (!gate.ready) error = createQaError('REAL_PROVIDER_GATE_BLOCKED', 'Real provider call was blocked by the QA gate.');
    } catch (gateError) {
      error = gateError;
    }
    if (!error) {
      try {
        result = await execute({ resultWriter: writer });
      } catch (executeError) {
        error = executeError;
        await writer.markInterrupted({ stage: executeError?.code || 'INTERRUPTED' }).catch(() => {});
      }
    }
    artifact = await writer.read();
    if (!artifact && !error) error = createQaError('QA_ARTIFACT_NOT_READABLE', 'QA artifact could not be read after execution.');
    if (artifact && typeof consumeArtifact === 'function') {
      await consumeArtifact({ artifact, artifactPath: writer.filePath, result, error });
    }
    return {
      ok: !error,
      result,
      error,
      artifact,
      artifactPath: writer.filePath,
    };
  } finally {
    await writer.cleanup();
  }
};

module.exports = {
  runInsightQaInProcess,
};
