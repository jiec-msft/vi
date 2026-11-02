const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareProvider } = require('./prepare-provider.cjs');
const { regularProviderInventory } = require('./distribution-files.cjs');

async function distributionProvider(output, staging) {
  const upstream = await prepareProvider(staging);
  fs.cpSync(staging, output, { recursive: true });
  fs.rmSync(path.join(output, 'provider.tgz'));
  const source = regularProviderInventory(output);
  const metadataFile = path.join(output, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (metadata.version !== '0.1.1') throw new Error('Unexpected public provider version.');
  const lock = require('../package-lock.json');
  const ws = lock.packages['node_modules/ws'];
  if (ws.version !== require('../package.json').dependencies.ws || ws.dependencies) {
    throw new Error('Review the pinned provider production dependency closure.');
  }
  metadata.dependencies = { ws: ws.version };
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(output, 'package-lock.json'), JSON.stringify({
    name: metadata.name, version: metadata.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: metadata.name, version: metadata.version, dependencies: metadata.dependencies },
      'node_modules/ws': ws },
  }, null, 2));
  const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec, ['/c', 'npm.cmd', ...args], { cwd: output, stdio: 'inherit', timeout: 60000 });
  } else execFileSync('npm', args, { cwd: output, stdio: 'inherit', timeout: 60000 });
  const installed = regularProviderInventory(output);
  for (const [file, identity] of Object.entries(source)) {
    if (file === 'package.json' || file.startsWith('node_modules/')) continue;
    const actual = installed[file];
    if (!actual || actual.sha256 !== identity.sha256) throw new Error('Public provider source changed during dependency installation.');
  }
  fs.writeFileSync(path.join(output, 'config.json'), '{}');
  return { upstream, providerVersion: metadata.version, source,
    upstreamLicenseDeclaration: Object.hasOwn(metadata, 'license') ? metadata.license : null,
    packagingChanges: ['declared production dependencies', 'production lock', 'neutral empty config'],
    files: regularProviderInventory(output) };
}

module.exports = { distributionProvider };
