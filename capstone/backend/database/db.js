const { Pool } = require("pg");

const localConfig = {
  host: "localhost",
  user: "postgres",
  password: "Vincent275!",
  database: "Capstone",
  port: 5432,
};

const railwayConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    }
  : localConfig;

const pool = new Pool(railwayConfig);


pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
