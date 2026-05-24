const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = __dirname;
const reportPath = path.join(repoRoot, 'codex-railway-diagnose.report.json');

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
    .slice(0, 12000);
}

function add(entry) {
  report.push({ time: new Date().toISOString(), ...entry });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const bits = [entry.step];
  if (entry.status !== undefined) bits.push(`status=${entry.status}`);
  if (entry.error) bits.push('error');
  if (entry.deployment?.status) bits.push(`deployment=${entry.deployment.status}`);
  if (entry.bundlePath) bits.push(`bundle=${entry.bundlePath}`);
  console.log(bits.filter(Boolean).join(' '));
}

function findRailwayExe() {
  const npxRoot = path.join(repoRoot, '.npm-cache-cli', '_npx');
  if (!fs.existsSync(npxRoot)) return null;
  const matches = [];
  for (const dir of fs.readdirSync(npxRoot)) {
    const exe = path.join(npxRoot, dir, 'node_modules', '@railway', 'cli', 'bin', 'railway.exe');
    if (fs.existsSync(exe)) {
      matches.push({ exe, mtime: fs.statSync(exe).mtimeMs });
    }
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.exe || null;
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function runRailway(args, timeout = 240000) {
  const env = {
    ...process.env,
    npm_config_cache: path.join(repoRoot, '.npm-cache-cli'),
  };
  if (token) {
    env.RAILWAY_TOKEN = token;
    env.RAILWAY_API_TOKEN = token;
  }

  const railwayExe = findRailwayExe();
  const cwd = repoRoot;
  const result = railwayExe
    ? spawnSync(railwayExe, args, { cwd, env, encoding: 'utf8', timeout })
    : spawnSync('cmd.exe', ['/d', '/s', '/c', [
        cmdQuote('C:\\Program Files\\nodejs\\npx.cmd'),
        '--yes',
        '@railway/cli@latest',
        ...args.map(cmdQuote),
      ].join(' ')], { cwd, env, encoding: 'utf8', timeout });

  return {
    status: result.status,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    error: result.error ? redact(result.error.message) : null,
    signal: result.signal || null,
  };
}

async function rawGql(mode, query, variables) {
  if (!token) throw new Error('RAILWAY_TOKEN or RAILWAY_API_TOKEN is required.');
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
  return {
    mode: result.mode,
    project: { id: result.data.project.id, name: result.data.project.name },
    services: result.data.project.services.edges.map((edge) => ({
      id: edge.node.id,
      name: edge.node.name,
      instances: edge.node.serviceInstances.edges.map((instanceEdge) => instanceEdge.node),
    })),
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

async function getLiveBundle() {
  const nonce = Date.now();
  const page = await fetch(`https://theresiansquest.com/?codex_verify=${nonce}`, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  });
  const html = await page.text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((match) => match[1]);
  const manifestResponse = await fetch(`https://theresiansquest.com/asset-manifest.json?codex_verify=${nonce}`, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  });
  const manifestText = await manifestResponse.text();
  let manifest = {};
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    manifest = {};
  }
  const scriptPath = manifest.files?.['main.js'] || scripts[0] || null;
  const bundle = {
    pageStatus: page.status,
    pageLastModified: page.headers.get('last-modified'),
    pageCacheControl: page.headers.get('cache-control'),
    pageServer: page.headers.get('server'),
    scripts,
    manifestStatus: manifestResponse.status,
    manifestMainJs: manifest.files?.['main.js'] || null,
    manifestMainCss: manifest.files?.['main.css'] || null,
    bundlePath: scriptPath,
  };
  if (scriptPath) {
    const bundleResponse = await fetch(`https://theresiansquest.com${scriptPath}?codex_verify=${nonce}`, {
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    });
    const text = await bundleResponse.text();
    bundle.bundleStatus = bundleResponse.status;
    bundle.bundleBytes = text.length;
    bundle.hasBasicAddition = text.includes('Basic Addition');
    bundle.hasNormalAverage = text.includes('Normal / Average');
    bundle.hasLocalhost = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(text);
  }
  return bundle;
}

async function main() {
  add({ step: 'start', tokenPresent: Boolean(token), repoRoot, targetCommit: TARGET_COMMIT, railwayExe: findRailwayExe() || 'npx fallback' });

  add({ step: 'railway-status', ...runRailway(['status', '--json']) });
  add({ step: 'railway-service-status', ...runRailway(['service', 'status', '--service', SERVICE_ID, '--project', PROJECT_ID, '--environment', ENVIRONMENT_ID, '--json']) });
  add({ step: 'railway-deployment-list', ...runRailway(['deployment', 'list', '--service', SERVICE_ID, '--environment', ENVIRONMENT_ID, '--limit', '30', '--json']) });

  add({ step: 'project-config', ...(await getProjectConfig()) });
  const deployments = await getDeployments();
  add({ step: 'graphql-deployments', ...deployments });
  const targetDeployment = deployments.deployments.find((deployment) => deployment.commitHash === TARGET_COMMIT);
  add({ step: 'target-deployment', deployment: targetDeployment || null });

  const latestDeploymentId = targetDeployment?.id || deployments.deployments[0]?.id || null;
  if (latestDeploymentId) {
    add({ step: 'target-build-logs', deploymentId: latestDeploymentId, ...runRailway(['logs', latestDeploymentId, '--build', '--lines', '250', '--json', '--service', SERVICE_ID, '--environment', ENVIRONMENT_ID]) });
    add({ step: 'target-runtime-logs', deploymentId: latestDeploymentId, ...runRailway(['logs', latestDeploymentId, '--deployment', '--lines', '250', '--json', '--service', SERVICE_ID, '--environment', ENVIRONMENT_ID]) });
  }

  add({ step: 'http-error-logs', ...runRailway(['logs', '--http', '--status', '>=400', '--lines', '100', '--json', '--service', SERVICE_ID, '--environment', ENVIRONMENT_ID]) });
  add({ step: 'runtime-files-app-build-js', ...runRailway(['service', 'files', 'list', '/app/build/static/js', '--json']) });
  add({ step: 'runtime-files-app-capstone-build-js', ...runRailway(['service', 'files', 'list', '/app/capstone/build/static/js', '--json']) });
  add({ step: 'runtime-files-app-root', ...runRailway(['service', 'files', 'list', '/app', '--json']) });

  add({ step: 'live-bundle-now', ...(await getLiveBundle()) });
}

main().catch((error) => {
  add({ step: 'fatal-error', error: redact(error.message || error) });
  process.exit(1);
});
