const { buildReleaseDatabaseConfig } = require('../releaseMigrations');
const { QA_ENVIRONMENT_NAME, bootstrapEmptyQaSchema } = require('./bootstrapEmptyQaSchema');

async function bootstrapQaSchemaIfNeeded({
  env = process.env,
  Client,
  bootstrap = bootstrapEmptyQaSchema,
} = {}) {
  if (env.RAILWAY_ENVIRONMENT_NAME !== QA_ENVIRONMENT_NAME) {
    return { bootstrapped: false, reason: 'not_qa_environment' };
  }

  const databaseConfig = buildReleaseDatabaseConfig(env);
  if (!databaseConfig) throw new Error('QA database configuration is required for schema bootstrap');

  const PgClient = Client || require('pg').Client;
  const client = new PgClient(databaseConfig);
  let latestVersion = 0;
  try {
    await client.connect();
    const migrationTable = await client.query("SELECT to_regclass('public.schema_migrations') AS migration_table");
    if (migrationTable.rows[0]?.migration_table) {
      const result = await client.query(
        'SELECT COALESCE(MAX(version), 0)::INTEGER AS latest_version FROM public.schema_migrations',
      );
      latestVersion = Number(result.rows[0]?.latest_version || 0);
    }
  } finally {
    await client.end();
  }

  if (latestVersion > 0) return { bootstrapped: false, latestVersion };

  await bootstrap({ env, Client: PgClient });
  return { bootstrapped: true, latestVersion: 0 };
}

module.exports = { bootstrapQaSchemaIfNeeded };
