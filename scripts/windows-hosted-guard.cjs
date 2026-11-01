const assert = require('node:assert/strict');

function hostedGuard(env = process.env, platform = process.platform, arch = process.arch) {
  assert.ok(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    env.RUNNER_OS === 'Windows' && platform === 'win32' &&
    /^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || '') &&
    ['x64', 'arm64'].includes(arch) && arch === env.VI_EXPECTED_ARCH,
  'Native GitHub-hosted Actions Windows job required.');
}

module.exports = { hostedGuard };
