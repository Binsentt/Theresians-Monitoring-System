const { runReleaseMigrations } = require('../releaseMigrations');
const { bootstrapQaSchemaIfNeeded } = require('./qaReleaseSchema');

async function main() {
  await bootstrapQaSchemaIfNeeded();
  await runReleaseMigrations();
}

main()
  .then(() => console.log('Release migrations applied: 018, 019, 020, 021, 022, 023, 024'))
  .catch((error) => {
    console.error(`Release migrations failed: ${error.message}`);
    process.exitCode = 1;
  });
