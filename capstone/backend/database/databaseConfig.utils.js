const buildDatabaseConfig = (env = process.env) => {
  if (env.DATABASE_URL) {
    return {
      connectionString: env.DATABASE_URL,
      ssl: env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    };
  }

  return {
    host: env.PGHOST || "localhost",
    user: env.PGUSER || "postgres",
    password: env.PGPASSWORD || "",
    database: env.PGDATABASE || "Capstone",
    port: Number(env.PGPORT) || 5432,
  };
};

module.exports = {
  buildDatabaseConfig,
};
