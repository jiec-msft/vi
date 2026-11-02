function providerSetup(action) {
  try { return action(); }
  catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`Provider setup failed: ${detail}`, { cause });
    error.code = 'ERR_PROVIDER_SETUP';
    throw error;
  }
}

function providerErrorKind(error) {
  return error?.code === 'ERR_PROVIDER_SETUP' ? 'provider' : 'cloud';
}

module.exports = { providerSetup, providerErrorKind };
