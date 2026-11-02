const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const resources = fs.realpathSync(process.argv[2]);
const authority = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const app = path.join(resources, 'app');
const providerRoot = path.join(resources, 'providers', 'default');
const appRequire = createRequire(path.join(app, 'package.json'));
const { providerOptions, siblingConfig } = appRequire('./app/provider-config.cjs');
const { instantiateSession } = appRequire('./app/provider-module.cjs');
const local = createRequire(path.join(providerRoot, 'package.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(providerRoot, 'plugin.json'), 'utf8'));
const entry = path.join(providerRoot, manifest.entry);
const external = siblingConfig(process.execPath, process.platform);
assert.equal(process.versions.electron, authority.electron);
assert.equal(process.arch, authority.architecture);
const denied = ['NODE_PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'ELECTRON_NO_ASAR', 'ELECTRON_DISABLE_SANDBOX'];
assert.ok(!Object.keys(process.env).some((name) => denied.includes(name.toUpperCase())));
assert.ok(!Object.keys(process.env).some((name) => /TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY/.test(name.toUpperCase())));
assert.ok(!fs.existsSync(external), 'A neutral base must not include external defaults.');
const before = new Set(Object.keys(require.cache));
async function main() {
  const { createProvider, createSession } = local(entry);
  assert.equal(typeof createProvider, 'function');
  assert.equal(typeof createSession, 'function');
  const { createService } = local(path.join(providerRoot, 'fixtures', 'provider-service.cjs'));
  const service = await createService();
  let provider, session;
  try {
    fs.writeFileSync(external, JSON.stringify({ schemaVersion: 1, endpoint: service.endpoint }));
    const options = providerOptions({ bundled: JSON.parse(fs.readFileSync(path.join(providerRoot, 'config.json'))),
      override: {}, executable: process.execPath, platform: process.platform, packaged: true });
    options.credentialSource = async () => ({ token: 'fixture-credential' });
    provider = createProvider(options);
    provider.on('failure', (error) => assert.fail(error));
    await provider.open();
    provider.audio(Buffer.alloc(2048));
    assert.equal(await provider.finish(), 'Fixture final text');
    session = instantiateSession(providerRoot, options);
    session.on('failure', (error) => assert.fail(error));
    await session.start();
    await session.audio(Buffer.alloc(2048));
    assert.equal(await session.finish(), 'Fixture final text');
    assert.equal(service.bytes(), 4096);
  } finally {
    provider?.close();
    session?.cancel();
    await service.close();
    fs.rmSync(external, { force: true });
  }
  const modules = Object.keys(require.cache).filter((file) => !before.has(file)).map((file) => {
    const relative = path.relative(providerRoot, fs.realpathSync(file)).split(path.sep).join('/');
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'Provider module resolved outside its deliverable.');
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), authority.provider.files[relative].sha256);
    return relative;
  });
  assert.throws(() => providerOptions({ bundled: {}, override: {}, executable: process.execPath,
    platform: process.platform, packaged: true }), /not configured/);
  console.log(JSON.stringify({ architecture: process.arch, electron: process.versions.electron,
    defaultEntryLoaded: true, bothFactories: true, syntheticLoopbackAudioBytes: 4096,
    dataOnlySiblingConfig: true, missingDefaultsRejected: true, modules,
    microphoneUsed: false, externalServiceCalled: false, credentialLookupCalled: false }));
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
