const createJestConfig = require('react-scripts/scripts/utils/createJestConfig');

const config = createJestConfig(
  (relativePath) => require.resolve(`react-scripts/${relativePath}`),
  __dirname,
  false
);

delete config.testMatch;
config.testRegex = ['.*\\.test\\.(js|jsx)$'];

module.exports = config;
