const { runReleaseMigrations } = require('../releaseMigrations');

runReleaseMigrations()
  .then(() => console.log('Release migrations applied: 018, 019, 020'))
  .catch((error) => {
    console.error(`Release migrations failed: ${error.message}`);
    process.exitCode = 1;
  });
