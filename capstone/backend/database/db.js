const { Pool } = require("pg");
const { buildDatabaseConfig } = require("./databaseConfig.utils");
const pool = new Pool(buildDatabaseConfig());


pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
