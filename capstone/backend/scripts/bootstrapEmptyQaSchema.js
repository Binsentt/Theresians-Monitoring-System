const QA_ENVIRONMENT_NAME = 'qa-owner-testing';

const CREATE_EMPTY_ACCOUNTS_TABLE = `
  CREATE TABLE IF NOT EXISTS public.accounts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    parent_id VARCHAR(6),
    game_student_id VARCHAR(8),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )
`;

async function bootstrapEmptyQaSchema({ env = process.env, Client, loadServer = () => require('../server'), logger = console } = {}) {
  if (env.RAILWAY_ENVIRONMENT_NAME !== QA_ENVIRONMENT_NAME) {
    throw new Error(`schema bootstrap is only allowed in ${QA_ENVIRONMENT_NAME}`);
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for QA schema bootstrap');

  const PgClient = Client || require('pg').Client;
  const client = new PgClient({
    connectionString: env.DATABASE_URL,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  let databaseName;
  try {
    await client.connect();
    await client.query(CREATE_EMPTY_ACCOUNTS_TABLE);
    const [databaseResult, accountResult] = await Promise.all([
      client.query('SELECT current_database() AS database_name'),
      client.query('SELECT COUNT(*)::INTEGER AS account_count FROM public.accounts'),
    ]);
    const accountCount = Number(accountResult.rows[0]?.account_count);
    if (!Number.isInteger(accountCount) || accountCount !== 0) {
      throw new Error('QA accounts table must be empty before schema bootstrap');
    }
    databaseName = String(databaseResult.rows[0]?.database_name || 'unknown');
  } finally {
    await client.end();
  }

  await loadServer().schemaReady;
  logger.log(`QA database confirmed: environment=${QA_ENVIRONMENT_NAME} database=${databaseName} accounts=0`);
}

if (require.main === module) {
  bootstrapEmptyQaSchema()
    .then(() => {
      console.log('QA empty application schema bootstrap complete');
      process.exit(0);
    })
    .catch((error) => {
      console.error(`QA schema bootstrap failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { QA_ENVIRONMENT_NAME, bootstrapEmptyQaSchema };
