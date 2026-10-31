const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function hostedGuard(env = process.env, platform = process.platform, arch = process.arch) {
  assert.ok(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    env.RUNNER_OS === 'Windows' && platform === 'win32' &&
    /^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || '') &&
    ['x64', 'arm64'].includes(arch) && arch === env.VI_EXPECTED_ARCH,
  'Native GitHub-hosted Actions Windows job required.');
}
module.exports = { hostedGuard };

if (require.main === module) {
  hostedGuard();
  run().catch(async (error) => {
    const { app } = require('electron');
    const directory = argument('output');
    await fs.writeFile(path.join(directory, 'fixture-error.json'), JSON.stringify({ error: error.message }));
    app.exit(1);
  });
}
function argument(name) {
  const prefix = `--desktop-probe-${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  assert.ok(value, `Missing probe argument: ${name}`);
  return value.slice(prefix.length);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(action, label, seconds = 15) {
  const deadline = Date.now() + seconds * 1000;
  do {
    if (await action()) return;
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Probe timed out: ${label}`);
}
async function run() {
  const { app, BrowserWindow, screen, desktopCapturer, nativeImage } = require('electron');
  const { recordDesktop } = require('./desktop-evidence.cjs');
  const { fiveMarkersVisible } = require('./visible-markers.cjs');
  const role = argument('role'), testCase = argument('case'), desktop = argument('name');
  const directory = path.resolve(argument('output'));
  assert.ok(['default', 'owned'].includes(role) && ['normal', 'failure', 'timeout'].includes(testCase));
  app.setPath('userData', path.join(directory, 'profile'));
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  await app.whenReady();
  const bounds = screen.getPrimaryDisplay().bounds;
  const window = new BrowserWindow({ ...bounds, frame: false, show: false,
    backgroundColor: role === 'owned' ? '#172434' : '#125620',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const markers = ['left:8px;top:8px', 'right:8px;top:8px', 'left:8px;bottom:8px',
    'right:8px;bottom:8px', 'left:50%;top:50%'].map((position) =>
    `<i style="position:fixed;${position};width:40px;height:40px;background:${role === 'owned' ? '#ff00ff' : '#00ff00'}"></i>`).join('');
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<body style="margin:0;background:${role === 'owned' ? '#172434' : '#125620'};color:white;font:28px sans-serif">
    ${markers}<main style="padding:90px"><h1>Owned CI ${role} desktop fixture</h1>
    <p>Fake input only. No provider or account.</p>
    <button id="click" style="padding:24px;font:24px sans-serif">Real OS mouse: waiting</button>
    <p id="result">No input received</p></main><script>
    document.getElementById('click').addEventListener('click', event => {
      document.getElementById('result').textContent = event.isTrusted ? 'Trusted OS click received' : 'Untrusted click rejected';
      document.getElementById('click').textContent = 'OS click complete';
    });</script></body>`));
  window.show();
  await fs.writeFile(path.join(directory, 'ready.tmp'), JSON.stringify({ pid: process.pid, role, desktop }));
  await fs.rename(path.join(directory, 'ready.tmp'), path.join(directory, 'ready.json'));
  if (role === 'default') {
    const timer = setInterval(() => {
      fs.writeFile(path.join(directory, 'heartbeat.tmp'), JSON.stringify({ pid: process.pid, time: Date.now() }))
        .then(() => fs.rename(path.join(directory, 'heartbeat.tmp'), path.join(directory, 'heartbeat.json')))
        .catch((error) => { clearInterval(timer); throw error; });
    }, 250);
    return;
  }
  // No renderer sendInputEvent, synthetic DOM click, window-only screenshot or foreground override.
  const visible = (png) => {
    const image = nativeImage.createFromBuffer(png);
    const { width, height } = image.getSize();
    return fiveMarkersVisible(image.toBitmap(), width, height);
  };
  await until(async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    return sources[0] && visible(sources[0].thumbnail.toPNG());
  }, 'five owned markers on actual desktop capture');
  let frames = 0;
  const stop = await recordDesktop(directory, (png) => {
    assert.ok(visible(png), 'Owned desktop capture is black, default, incomplete or obscured.');
    frames++;
  });
  let fixtureError;
  try {
    const point = await window.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('click').getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
    })()`);
    const scale = screen.getPrimaryDisplay().scaleFactor;
    const mouse = spawn(process.env.VI_DESKTOP_PWSH, ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'windows-ci-desktop.ps1'), '-Case', 'input', '-DesktopName', desktop,
      '-TargetProcessId', String(process.pid), '-X', String(Math.round((bounds.x + point.x) * scale)),
      '-Y', String(Math.round((bounds.y + point.y) * scale)), '-Output', directory],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    mouse.stdout.on('data', (bytes) => { diagnostics += bytes; });
    mouse.stderr.on('data', (bytes) => { diagnostics += bytes; });
    await new Promise((resolve, reject) => {
      mouse.once('error', reject);
      mouse.once('exit', (code) => code === 0 ? resolve() :
        reject(new Error(`Owned native mouse child exited ${code}: ${diagnostics.slice(-2000)}`)));
    });
    await until(() => window.webContents.executeJavaScript(
      "document.getElementById('result').textContent === 'Trusted OS click received'"), 'trusted OS click in renderer');
    await pause(1500);
  } catch (error) { fixtureError = error; }
  const media = await stop();
  await fs.writeFile(path.join(directory, 'fixture-report.json'), JSON.stringify({
    role, desktop, pid: process.pid, arch: process.arch, frameCount: frames,
    trustedOsClick: !fixtureError, ...media, error: fixtureError?.message,
  }, null, 2));
  if (fixtureError) throw fixtureError;
  if (testCase === 'timeout') {
    await fs.writeFile(path.join(directory, 'timeout-ready.json'), JSON.stringify({ pid: process.pid }));
    return;
  }
  window.destroy();
  app.exit(testCase === 'failure' ? 37 : 0);
}
