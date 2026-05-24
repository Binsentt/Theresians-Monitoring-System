const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = __dirname;
const reportPath = path.join(repoRoot, 'codex-railway-action.report.json');

const PROJECT_ID = 'dd2c27df-22e4-4ee0-82dc-a1c510b07d0c';
const ENVIRONMENT_ID = 'f451f63b-55ed-46f5-abe3-53a439ac1fec';
const SERVICE_ID = 'efe9f84c-7d05-4698-be00-452c22b47ec7';
const TARGET_COMMIT = '7c57831dcfb1a33be330eaa9061bca5ca87e263c';
const SERVICE_NAME = 'Theresians-Monitoring-System';

const token = process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN;
const report = [];

function redact(value) {
  return String(value || '')
    .replace(/postgres:\/\/\S+/gi, '<redacted-db-url>')
    .replace(/re_[A-Za-z0-9_\-]{8,}/g, '<redacted-resend-key>')
    .replace(/[A-Za-z0-9_\-]{48,}/g, '<redacted-long-value>')
    .slice(0, 4000);
}

function writeReport() {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function add(step) {
  report.push({ time: new Date().toISOString(), ...step });
  writeReport();
}

async function gql(query, variables, inputHeaders) {
  const headers = inputHeaders || { 'Project-Access-Token': token };
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
  if (json.errors) {
    throw new Error(json.errors.map((error) => error.message).join('; '));
  }
  return json.data;
}

async function gqlAny(query, variables) {
  const attempts = [
    ['project-token', { 'Project-Access-Token': token }],
    ['bearer', { authorization: `Bearer ${token}` }],
  ];
  const errors = [];
  for (const [mode, headers] of attempts) {
    try {
      const data = await gql(query, variables, headers);
      return { mode, data };
    } catch (error) {
      errors.push({ mode, error: redact(error.message) });
    }
  }
  throw new Error(JSON.stringify(errors));
}

function summarizeDeployment(node) {
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

function runRailway(args, cwd) {
  const env = {
    ...process.env,
    npm_config_cache: path.join(repoRoot, '.npm-cache-cli'),
    RAILWAY_TOKEN: token,
  };
  delete env.RAILWAY_API_TOKEN;
  const result = spawnSync('C:\\Program Files\\nodejs\\npx.cmd', ['--yes', '@railway/cli@latest', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120000,
  });
  return {
    status: result.status,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

async function waitForDeployment(targetCommit) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const { mode, data } = await gqlAny(
      `query($environmentId:String!,$serviceId:String!){
        deployments(first:20, input:{environmentId:$environmentId, serviceId:$serviceId}) {
          edges { node { id status createdAt meta canRedeploy } }
        }
      }`,
      { environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID }
    );
    const deployments = data.deployments.edges.map((edge) => summarizeDeployment(edge.node));
    const target = deployments.find((deployment) => deployment.commitHash === targetCommit);
    add({ step: 'deployment-poll', mode, attempt, target: target || null, latest: deployments[0] || null });
    if (target && ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'].includes(target.status)) {
      return target;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`Timed out waiting for deployment for ${targetCommit}`);
}

async function fetchLiveBundle() {
  const page = await fetch('https://theresiansquest.com/', { redirect: 'follow' });
  const html = await page.text();
  const scripts = [...html.matchAll(/static\/js\/[^"']+\.js/g)].map((match) => match[0]);
  let bundle = null;
  if (scripts[0]) {
    const response = await fetch(`https://theresiansquest.com/${scripts[0]}`);
    const text = await response.text();
    bundle = {
      script: scripts[0],
      status: response.status,
      bytes: text.length,
      hasBasicAddition: text.includes('Basic Addition'),
      hasNormalAverage: text.includes('Normal / Average'),
      hasLocalhost: /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(text),
    };
  }
  return { pageStatus: page.status, scripts, bundle };
}

async function main() {
  if (!token) throw new Error('RAILWAY_TOKEN is not set in this process.');
  add({ step: 'start', tokenPresent: true, targetCommit: TARGET_COMMIT });

  add({ step: 'railway-status', ...runRailway(['status', '--json'], path.join(repoRoot, 'capstone')) });
  add({ step: 'railway-service-list', ...runRailway(['service', 'list', '--json'], path.join(repoRoot, 'capstone')) });
  add({ step: 'railway-deployment-list', ...runRailway(['deployment', 'list', '--json'], path.join(repoRoot, 'capstone')) });

  const { mode, data } = await gqlAny(
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
  const service = data.project.services.edges.map((edge) => edge.node).find((entry) => entry.id === SERVICE_ID);
  const instance = service.serviceInstances.edges.map((edge) => edge.node).find((entry) => entry.environmentId === ENVIRONMENT_ID);
  add({
    step: 'project-config-before',
    mode,
    project: { id: data.project.id, name: data.project.name },
    service: { id: service.id, name: service.name },
    instance,
    variableNames: Object.keys(data.variables || {}).sort(),
    triggers: data.deploymentTriggers.edges.map((edge) => edge.node),
  });

  const updateInput = {
    rootDirectory: '/capstone',
    railwayConfigFile: '/capstone/railway.toml',
    buildCommand: null,
    startCommand: null,
    builder: 'NIXPACKS',
  };
  try {
    const update = await gqlAny(
      `mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){
        serviceInstanceUpdate(serviceId:$serviceId, environmentId:$environmentId, input:$input)
      }`,
      { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, input: updateInput }
    );
    add({ step: 'service-instance-update', mode: update.mode, ok: true, requested: updateInput, result: update.data.serviceInstanceUpdate });
  } catch (error) {
    add({ step: 'service-instance-update', ok: false, requested: updateInput, error: redact(error.message) });
  }

  const after = await gqlAny(
    `query($projectId:String!,$environmentId:String!,$serviceId:String!){
      project(id:$projectId) {
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
    }`,
    { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID }
  );
  const afterService = after.data.project.services.edges.map((edge) => edge.node).find((entry) => entry.id === SERVICE_ID);
  const afterInstance = afterService.serviceInstances.edges.map((edge) => edge.node).find((entry) => entry.environmentId === ENVIRONMENT_ID);
  add({ step: 'project-config-after', mode: after.mode, instance: afterInstance });

  let deployResult = null;
  try {
    deployResult = await gqlAny(
      `mutation($serviceId:String!,$environmentId:String!,$commitSha:String!){
        serviceInstanceDeploy(serviceId:$serviceId, environmentId:$environmentId, commitSha:$commitSha)
      }`,
      { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, commitSha: TARGET_COMMIT }
    );
    add({ step: 'service-instance-deploy', mode: deployResult.mode, ok: true, result: deployResult.data.serviceInstanceDeploy });
  } catch (error) {
    add({ step: 'service-instance-deploy', ok: false, error: redact(error.message) });
    const cliDeploy = runRailway(['service', 'redeploy', SERVICE_NAME, '--yes', '--json'], path.join(repoRoot, 'capstone'));
    add({ step: 'service-redeploy-cli-fallback', ...cliDeploy });
  }

  const finalDeployment = await waitForDeployment(TARGET_COMMIT);
  add({ step: 'target-deployment-final', deployment: finalDeployment });

  const live = await fetchLiveBundle();
  add({ step: 'live-bundle', ...live });
}

main().catch((error) => {
  add({ step: 'fatal-error', error: redact(error.message || error) });
  process.exit(1);
});
