const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { digest, fileInventory } = require('./distribution-files.cjs');
const { distributionProvider } = require('./distribution-provider.cjs');

function distributionVersion(value) {
  if (typeof value !== 'string' || value.length > 64 ||
      !/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-preview(?:\.\d+)?)?$/.test(value)) {
    throw new Error('Use an explicit bounded numeric version, optionally -preview.N.');
  }
  return value;
}

function childEnv(profile) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
      'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'].includes(name.toUpperCase())) env[name] = value;
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) env[name] = profile;
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function architecture(file, arch) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    assert.equal(fs.readSync(fd, header, 0, 64, 0), 64);
    if (process.platform === 'win32') {
      assert.equal(header.readUInt16LE(0), 0x5a4d);
      const pe = Buffer.alloc(6);
      assert.equal(fs.readSync(fd, pe, 0, 6, header.readUInt32LE(60)), 6);
      assert.equal(pe.readUInt32LE(0), 0x4550);
      assert.equal(pe.readUInt16LE(4), arch === 'arm64' ? 0xaa64 : 0x8664);
      return { format: 'PE', machine: pe.readUInt16LE(4), architecture: arch };
    } else {
      assert.equal(header.readUInt32LE(0), 0xfeedfacf);
      assert.equal(header.readUInt32LE(4), 0x100000c);
      assert.equal(arch, 'arm64');
      return { format: 'Mach-O', cpuType: header.readUInt32LE(4), architecture: arch };
    }
  } finally { fs.closeSync(fd); }
}

function sealMac(bundle) {
  const records = [];
  function walk(directory) {
    for (const item of fs.readdirSync(directory)) {
      const file = path.join(directory, item), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(file); if (/\.(app|framework|xpc)$/.test(file)) records.push(file); }
      else if (stat.isFile() && stat.size >= 4) {
        const fd = fs.openSync(file, 'r'), magic = Buffer.alloc(4);
        try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
        if ([0xfeedfacf, 0xcafebabe, 0xbebafeca].includes(magic.readUInt32LE(0))) records.push(file);
      }
    }
  }
  walk(bundle);
  for (const file of [...records, bundle]) execFileSync('codesign',
    ['--force', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', file],
    { stdio: 'inherit', timeout: 30000 });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit', timeout: 30000 });
}

async function main(version, arch) {
  distributionVersion(version);
  if (!['win32', 'darwin'].includes(process.platform) || process.arch !== arch ||
      !['x64', 'arm64'].includes(arch) || (process.platform === 'darwin' && arch !== 'arm64')) {
    throw new Error('Build each supported distribution on its matching native runner.');
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const output = path.resolve('artifacts-ci', 'distribution');
  if (fs.existsSync(output)) throw new Error('Distribution output must be new.');
  fs.mkdirSync(output, { recursive: true });
  const staging = path.join(output, 'staging');
  fs.mkdirSync(staging);
  const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  const bundle = process.platform === 'darwin' ? path.join(staging, 'VI.app') : staging;
  if (process.platform === 'darwin') fs.cpSync(path.join(electronDist, 'Electron.app'), bundle,
    { recursive: true, verbatimSymlinks: true });
  else {
    fs.cpSync(electronDist, staging, { recursive: true });
    fs.renameSync(path.join(staging, 'electron.exe'), path.join(staging, 'VI.exe'));
  }
  const contents = process.platform === 'darwin' ? path.join(bundle, 'Contents') : bundle;
  const resources = path.join(contents, process.platform === 'darwin' ? 'Resources' : 'resources');
  const app = path.join(resources, 'app');
  fs.mkdirSync(app);
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  for (const name of ['app', 'native']) fs.cpSync(path.resolve(name), path.join(app, name), { recursive: true });
  fs.copyFileSync('LICENSE', path.join(app, 'LICENSE'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'vi', productName: 'VI',
    version, main: 'app/main.cjs', license: 'MIT', private: true }));
  fs.writeFileSync(path.join(app, 'app', 'build-info.json'), JSON.stringify({
    frameworkRevision: revision, assemblyRevision: revision,
  }));
  const provider = await distributionProvider(path.join(resources, 'providers', 'default'),
    path.join(output, 'public-provider-download'));
  const executable = process.platform === 'darwin' ? path.join(contents, 'MacOS', 'VI') : path.join(contents, 'VI.exe');
  if (process.platform === 'darwin') {
    fs.renameSync(path.join(contents, 'MacOS', 'Electron'), executable);
    const plist = path.join(contents, 'Info.plist');
    const data = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    Object.assign(data, { CFBundleExecutable: 'VI', CFBundleName: 'VI',
      CFBundleDisplayName: 'VI', CFBundleIdentifier: 'org.vi.preview',
      CFBundleVersion: version.split('-')[0], CFBundleShortVersionString: version.split('-')[0],
      NSMicrophoneUsageDescription: 'Record only after an explicit recording or microphone test.' });
    const metadata = path.join(output, 'bundle-metadata.json');
    fs.writeFileSync(metadata, JSON.stringify(data));
    execFileSync('plutil', ['-convert', 'xml1', '-o', plist, metadata]);
    sealMac(bundle);
  } else execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts', 'distribution-version.ps1'),
    '-Executable', executable, '-Version', version], { stdio: 'inherit', timeout: 30000 });
  const nativeHeader = architecture(executable, arch);
  if (process.platform === 'darwin') architecture(path.join(app, 'native', 'macos-delivery'), arch);
  const sourceFiles = {};
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'app', 'native', 'LICENSE'],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const file of tracked) {
    const packaged = path.join(app, file);
    assert.equal(digest(packaged), digest(file), 'Packaged public source differs from the checked-out revision.');
    sourceFiles[file] = { sha256: digest(file), gitBlob: execFileSync('git', ['rev-parse', `HEAD:${file}`],
      { encoding: 'utf8' }).trim() };
  }
  const authority = { sourceRevision: revision, version, architecture: arch,
    electron: require('../package.json').devDependencies.electron, sourceFiles, provider };
  const authorityFile = path.join(output, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(authority, null, 2));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-native-base-'));
  const reports = [];
  function smoke(target, targetResources) {
    const appManifest = JSON.parse(fs.readFileSync(path.join(targetResources, 'app', 'package.json')));
    assert.equal(appManifest.version, version);
    assert.equal(appManifest.main, 'app/main.cjs');
    let versionMetadata;
    if (process.platform === 'darwin') {
      const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-',
        path.join(targetResources, '..', 'Info.plist')], { encoding: 'utf8' }));
      assert.equal(info.CFBundleExecutable, 'VI');
      assert.equal(info.CFBundleVersion, version.split('-')[0]);
      assert.equal(info.CFBundleShortVersionString, version.split('-')[0]);
      versionMetadata = { bundleVersion: info.CFBundleVersion, shortVersion: info.CFBundleShortVersionString };
    } else {
      versionMetadata = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
        '& {param($file) $v=(Get-Item -LiteralPath $file).VersionInfo; @{file=$v.FileVersion;product=$v.ProductVersion;name=$v.ProductName}|ConvertTo-Json -Compress}',
        target], { encoding: 'utf8', timeout: 10000 }));
      assert.equal(versionMetadata.file, `${version.split('-')[0]}.0`);
      assert.equal(versionMetadata.product, version);
      assert.equal(versionMetadata.name, 'VI');
    }
    const report = JSON.parse(execFileSync(target, [path.resolve('scripts', 'distribution-smoke.cjs'),
      targetResources, authorityFile], { env: childEnv(profile), cwd: profile,
      encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 262144 }).trim());
    reports.push({ ...report, versionMetadata, appVersion: appManifest.version });
  }
  try {
    smoke(executable, resources);
    if (process.platform === 'darwin') execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
    const files = fileInventory(staging);
    const zip = path.join(output, `VI-${version}-${process.platform === 'win32' ? 'windows' : 'macos'}-${arch}-neutral.zip`);
    if (process.platform === 'darwin') execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip],
      { timeout: 120000 });
    else execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts', 'distribution-archive.ps1'),
      '-Root', staging, '-Zip', zip], { timeout: 120000 });
    const extracted = path.join(output, 'fresh-extraction');
    if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, extracted], { timeout: 120000 });
    else execFileSync('powershell.exe', ['-NoProfile', '-Command',
      '& {param($file,$directory) Expand-Archive -LiteralPath $file -DestinationPath $directory -ErrorAction Stop}',
      zip, extracted], { timeout: 120000 });
    try {
      assert.deepEqual(fileInventory(extracted), files, 'Fresh native archive extraction changed payload bytes, links or modes.');
      const freshContents = process.platform === 'darwin' ? path.join(extracted, 'VI.app', 'Contents') : extracted;
      const freshExe = process.platform === 'darwin' ? path.join(freshContents, 'MacOS', 'VI') : path.join(freshContents, 'VI.exe');
      architecture(freshExe, arch);
      smoke(freshExe, path.join(freshContents, process.platform === 'darwin' ? 'Resources' : 'resources'));
      if (process.platform === 'darwin') execFileSync('codesign',
        ['--verify', '--deep', '--strict', path.join(extracted, 'VI.app')]);
    } finally { fs.rmSync(extracted, { recursive: true, force: true }); }
    fs.rmSync(profile, { recursive: true, force: true });
    assert.ok(!fs.existsSync(profile));
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ ...authority,
      archive: { file: path.basename(zip), bytes: fs.statSync(zip).size, sha256: digest(zip) },
      executableSha256: digest(executable), nativeHeader, payload: files, reports,
      signature: process.platform === 'darwin' ? 'ad-hoc strict verified before and after archive' : 'unsigned',
      helperRuntimeExercised: false, headlessOnly: true,
      cleanup: { packagedElectronChildrenExited: true, syntheticProfileRemoved: !fs.existsSync(profile),
        freshExtractionRemoved: !fs.existsSync(extracted) },
      externalDefaultsIncluded: false }, null, 2));
    fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${digest(zip)}  ${path.basename(zip)}\n`);
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}

module.exports = { distributionVersion, childEnv };
if (require.main === module) main(process.argv[2], process.argv[3]).catch((error) => {
  console.error(error.stack); process.exitCode = 1;
});
