const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = __dirname;
const capstoneRoot = path.join(repoRoot, 'capstone');
const reportPath = path.join(repoRoot, 'codex-railway-direct.report.json');

const PROJECT_ID = 'dd2c27df-22e4-4ee0-82dc-a1c510b07d0c';
const ENVIRONMENT_ID = 'f451f63b-55ed-46f5-abe3-53a439ac1fec';
const SERVICE_ID = 'efe9f84c-7d05-4698-be00-452c22b47ec7';
const TARGET_COMMIT = '7c57831dcfb1a33be330eaa9061bca5ca87e263c';

const token = process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN || '';
const report = [];

function redact(value) {
  return String(value || '')
    .replace(/postgres:\/\/\S+/gi, '<redacted-db-url>')
    .replace(/re_[A-Za-z0-9_\-]{8,}/g, '<redacted-resend-key>')
    .replace(/(DATABASE_URL|RESEND_API_KEY|EMAIL_FROM|EMAIL_FROM_NAME|NODE_ENV|TOKEN|SECRET|KEY|PASSWORD)(\s*[=:]\s*)\S+/gi, '$1$2<redacted>')
    .replace(/[A-Za-z0-9_\-]{48,}/g, '<redacted-long-value>')
    .slice(0, 8000);
}

function add(entry) {
  report.push({ time: new Date().toISOString(), ...entry });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const details = [];
  if (entry.step) details.push(entry.step);
  if (entry.status) details.push(`status=${entry.status}`);
  if (entry.attempt !== undefined) details.push(`attempt=${entry.attempt}`);
  if (entry.target?.status) details.push(`target=${entry.target.status}`);
  if (entry.latest?.status) details.push(`latest=${entry.latest.status}`);
  if (entry.deployment?.status) details.push(`deployment=${entry.deployment.status}`);
  console.log(`[${new Date().toISOString()}] ${details.join(' ')}`);
}

function runRailway(args, cwd = capstoneRoot) {
  const env = {
    ...process.env,
    RAILWAY_TOKEN: token || process.env.RAILWAY_TOKEN,
    npm_config_cache: path.join(repoRoot, '.npm-cache-cli'),
  };
  if (!token && process.env.RAILWAY_API_TOKEN) env.RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
  const result = spawnSync('C:\\Program Files\\nodejs\\npx.cmd', ['--yes', '@railway/cli@latest', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240000,
  });
  return {
    status: result.status,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    error: result.error ? redact(result.error.message) : null,
    signal: result.signal || null,
  };
}

async function rawGql(mode, query, variables) {
  if (!token) throw new Error('RAILWAY_TOKEN or RAILWAY_API_TOKEN is required for Railway GraphQL.');
  const headers = mode === 'project-token'
    ? { 'Project-Access-Token': token }
    : { authorization: `Bearer ${token}` };
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (json.errors) throw new Error(json.errors.map((error) => error.message).join('; '));
  return json.data;
}

async function gqlAny(query, variables) {
  const errors = [];
  for (const mode of ['project-token', 'bearer']) {
    try {
      const data = await rawGql(mode, query, variables);
      return { mode, data };
    } catch (error) {
      errors.push({ mode, error: redact(error.message) });
    }
  }
  throw new Error(JSON.stringify(errors));
}

function deploymentSummary(node) {
  const meta = node.meta || {};
  return {
    id: node.id,
    status: node.status,
    createdAt: node.createdAt,
    canRedeploy: node.canRedeploy,
    commitHash: meta.commitHash || meta.commit_sha || null,
    commitMessage: (meta.commitMessage || meta.commit_message || meta.message || '').split('\n')[0],
    branch: meta.branch || meta.branchName || null,
    repo: meta.repo || meta.repository || meta.githubRepo || null,
    root: meta.rootDirectory || meta.root_directory || null,
  };
}

async function getProjectConfig() {
  const result = await gqlAny(
    `query($projectId:String!,$environmentId:String!,$serviceId:String!){
      project(id:$projectId) {
        id
        name
        services {
          edges {
            node {
              id
              name
              serviceInstances {
                edges {
                  node {
                    id
                    environmentId
                    rootDirectory
                    buildCommand
                    startCommand
                    railwayConfigFile
                    source { image repo }
                  }
                }
              }
            }
          }
        }
      }
      deploymentTriggers(projectId:$projectId, environmentId:$environmentId, serviceId:$serviceId) {
        edges { node { id provider repository branch serviceId environmentId checkSuites validCheckSuites } }
      }
      variables(projectId:$projectId, environmentId:$environmentId, serviceId:$serviceId)
    }`,
    { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID }
  );
  const service = result.data.project.services.edges.map((edge) => edge.node).find((entry) => entry.id === SERVICE_ID);
  const instance = service.serviceInstances.edges.map((edge) => edge.node).find((entry) => entry.environmentId === ENVIRONMENT_ID);
  return {
    mode: result.mode,
    project: { id: result.data.project.id, name: result.data.project.name },
    service: { id: service.id, name: service.name },
    instance,
    triggers: result.data.deploymentTriggers.edges.map((edge) => edge.node),
    variableNames: Object.keys(result.data.variables || {}).sort(),
  };
}

async function getDeployments() {
  const result = await gqlAny(
    `query($environmentId:String!,$serviceId:String!){
      deployments(first:30, input:{environmentId:$environmentId, serviceId:$serviceId}) {
        edges { node { id status createdAt meta canRedeploy } }
      }
    }`,
    { environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID }
  );
  return {
    mode: result.mode,
    deployments: result.data.deployments.edges.map((edge) => deploymentSummary(edge.node)),
  };
}

async function waitForTargetDeployment() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const deployments = await getDeployments();
    const target = deployments.deployments.find((deployment) => deployment.commitHash === TARGET_COMMIT);
    add({ step: 'deployment-poll', attempt, mode: deployments.mode, target: target || null, latest: deployments.deployments[0] || null });
    if (target && ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'].includes(target.status)) return target;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`Timed out waiting for ${TARGET_COMMIT}`);
}

async function getLiveBundle() {
  const page = await fetch('https://theresiansquest.com/');
  const html = await page.text();
  const scripts = [...html.matchAll(/static\/js\/[^"']+\.js/g)].map((match) => match[0]);
  const bundle = { pageStatus: page.status, scripts };
  if (scripts[0]) {
    const response = await fetch(`https://theresiansquest.com/${scripts[0]}`);
    const text = await response.text();
    bundle.bundle = {
      script: scripts[0],
      status: response.status,
      bytes: text.length,
      hasBasicAddition: text.includes('Basic Addition'),
      hasNormalAverage: text.includes('Normal / Average'),
      hasLocalhost: /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(text),
    };
  }
  return bundle;
}

async function main() {
  add({ step: 'start', tokenPresent: Boolean(token), repoRoot, targetCommit: TARGET_COMMIT });
  add({ step: 'railway-status', ...runRailway(['status', '--json']) });
  add({ step: 'railway-service-list', ...runRailway(['service', 'list', '--json']) });
  add({ step: 'railway-deployment-list', ...runRailway(['deployment', 'list', '--json']) });

  const before = await getProjectConfig();
  add({ step: 'project-config-before', ...before });

  const nullOverrideInput = {
    rootDirectory: '/capstone',
    railwayConfigFile: '/capstone/railway.toml',
    buildCommand: null,
    startCommand: null,
    builder: 'NIXPACKS',
  };
  try {
    const updated = await gqlAny(
      `mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){
        serviceInstanceUpdate(serviceId:$serviceId, environmentId:$environmentId, input:$input)
      }`,
      { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, input: nullOverrideInput }
    );
    add({ step: 'service-instance-update-null-overrides', ok: true, mode: updated.mode, requested: nullOverrideInput });
  } catch (error) {
    add({ step: 'service-instance-update-null-overrides', ok: false, error: redact(error.message), requested: nullOverrideInput });
  }

  const afterNullUpdate = await getProjectConfig();
  add({ step: 'project-config-after-null-update', ...afterNullUpdate });

  const expectedBuildCommand = 'npm run build && npm --prefix backend ci --omit=dev';
  const expectedStartCommand = 'npm --prefix backend start';
  const needsExplicitCommands =
    afterNullUpdate.instance.buildCommand !== expectedBuildCommand ||
    afterNullUpdate.instance.startCommand !== expectedStartCommand ||
    afterNullUpdate.instance.rootDirectory !== '/capstone' ||
    afterNullUpdate.instance.railwayConfigFile !== '/capstone/railway.toml';

  if (needsExplicitCommands) {
    const explicitInput = {
      rootDirectory: '/capstone',
      railwayConfigFile: '/capstone/railway.toml',
      buildCommand: expectedBuildCommand,
      startCommand: expectedStartCommand,
      builder: 'NIXPACKS',
    };
    const explicitUpdate = await gqlAny(
      `mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){
        serviceInstanceUpdate(serviceId:$serviceId, environmentId:$environmentId, input:$input)
      }`,
      { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, input: explicitInput }
    );
    add({ step: 'service-instance-update-explicit-commands', ok: true, mode: explicitUpdate.mode, requested: explicitInput });
  }

  add({ step: 'project-config-after', ...(await getProjectConfig()) });

  try {
    const deploy = await gqlAny(
      `mutation($serviceId:String!,$environmentId:String!,$commitSha:String!){
        serviceInstanceDeploy(serviceId:$serviceId, environmentId:$environmentId, commitSha:$commitSha)
      }`,
      { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, commitSha: TARGET_COMMIT }
    );
    add({ step: 'service-instance-deploy-target-commit', ok: true, mode: deploy.mode, result: deploy.data.serviceInstanceDeploy });
  } catch (error) {
    add({ step: 'service-instance-deploy-target-commit', ok: false, error: redact(error.message) });
    add({ step: 'railway-redeploy-fallback', ...runRailway(['redeploy', '--service', SERVICE_ID, '--environment', ENVIRONMENT_ID, '--yes', '--json']) });
  }

  const finalDeployment = await waitForTargetDeployment();
  add({ step: 'target-deployment-final', deployment: finalDeployment });
  add({
    step: 'target-build-logs',
    deploymentId: finalDeployment.id,
    ...runRailway(['logs', finalDeployment.id, '--build', '--lines', '200', '--json', '--service', SERVICE_ID, '--environment', ENVIRONMENT_ID]),
  });
  add({
    step: 'target-runtime-logs',
    deploymentId: finalDeployment.id,
    ...runRailway(['logs', finalDeployment.id, '--deployment', '--lines', '200', '--json', '--service', SERVICE_ID, '--environment', ENVIRONMENT_ID]),
  });
  add({ step: 'live-bundle-after-deploy', ...(await getLiveBundle()) });
}

main().catch((error) => {
  add({ step: 'fatal-error', error: redact(error.message || error) });
  process.exit(1);
});
