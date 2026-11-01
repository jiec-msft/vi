const { app, BrowserWindow, desktopCapturer, nativeImage, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { recordDesktop } = require('./desktop-evidence.cjs');
const { fiveMarkersVisible } = require('./visible-markers.cjs');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Cue probes run only on isolated CI runners.');
assert.ok(process.argv.includes('--ci-mode=cues') && process.env.VI_CUES_OUTPUT);
assert.equal(process.arch, process.env.VI_EXPECTED_ARCH);
app.on('window-all-closed', () => {});
const directory = path.resolve(process.env.VI_CUES_OUTPUT);
app.commandLine.appendSwitch('user-data-dir', path.join(directory, 'profile'));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
if (process.platform === 'darwin') app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
const report = { platform: process.platform, arch: process.arch, headSha: process.env.VI_CUES_HEAD,
  physicalSpeakerAudibility: 'not-verified-manual-listening-required' };
let window, stopVideo;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function visible() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
  return sources.some((source) => {
    const image = nativeImage.createFromBuffer(source.thumbnail.toPNG()), size = image.getSize();
    return fiveMarkersVisible(image.toBitmap(), size.width, size.height);
  });
}
function waveFile(samples, sampleRate) {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(Math.round(sample * 32767), 44 + index * 2));
  return wav;
}
async function run() {
  await app.whenReady();
  const area = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({ x: area.x + 10, y: area.y + 10,
    width: Math.min(760, area.width - 20), height: Math.min(820, area.height - 20),
    alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required' } });
  await window.loadFile(path.resolve('scripts', 'cues-probe.html'));
  window.show(); window.moveTop(); window.focus();
  const renderer = await fs.readFile(path.resolve('app', 'renderer.js'), 'utf8');
  const end = renderer.indexOf('\nfunction showStatus(');
  assert.ok(end > 0, 'Renderer cue entrypoint was not found.');
  await window.webContents.executeJavaScript(renderer.slice(0, end) +
    '\nwindow.playRendererCue = kind => cue(kind); window.setCueSounds = enabled => { soundsEnabled = enabled; }; undefined;');
  const deadline = Date.now() + 15000;
  while (!(await visible())) {
    if (Date.now() >= deadline) throw new Error('Cue probe is not visible on the native desktop.');
    await pause(100);
  }
  stopVideo = await recordDesktop(directory, (png) => {
    const image = nativeImage.createFromBuffer(png), size = image.getSize();
    const marked = fiveMarkersVisible(image.toBitmap(), size.width, size.height);
    if (!marked && !report.visibilityFailure) {
      report.visibilityFailure = 'visibility-failure.png';
      writeFileSync(path.join(directory, report.visibilityFailure), png);
    }
    assert.ok(marked, 'Cue probe was obscured in desktop evidence.');
  });
  const result = await window.webContents.executeJavaScript('window.runCueProbe()');
  report.checks = result.checks;
  report.contextCount = result.contextCount;
  report.outputScope = result.outputScope;
  report.deviceScope = result.deviceScope;
  report.recordings = [];
  for (const { samples, ...summary } of result.recordings) {
    const filename = `${summary.round}-${summary.kind}.wav`;
    await fs.writeFile(path.join(directory, filename), waveFile(samples, summary.sampleRate));
    report.recordings.push({ ...summary, pcmFile: filename });
  }
  await pause(1000);
  report.status = 'passed';
}
run().catch((error) => {
  report.status = 'failed'; report.error = error.stack || String(error); console.error(error); process.exitCode = 1;
}).finally(async () => {
  try {
    if (window && !window.isDestroyed()) {
      report.contexts = await window.webContents.executeJavaScript(
        'typeof window.cueProbeDiagnostics === "function" ? window.cueProbeDiagnostics() : []');
      const failedRecordings = await window.webContents.executeJavaScript(
        'typeof window.cueProbeFailureRecordings === "function" ? window.cueProbeFailureRecordings() : []');
      report.failedRecordings = [];
      for (const [index, recording] of failedRecordings.entries()) {
        assert.ok(recording.samples.length <= recording.sampleRate * 2, 'Synthetic failure PCM exceeded its bound.');
        const filename = `synthetic-quiet-failure-${index}.wav`;
        await fs.writeFile(path.join(directory, filename), waveFile(recording.samples, recording.sampleRate));
        report.failedRecordings.push({ pcmFile: filename, measurement: recording.measurement });
      }
    }
    if (stopVideo) Object.assign(report, await stopVideo());
  } catch (error) {
    report.status = 'failed'; report.evidenceError = error.stack || String(error); console.error(error); process.exitCode = 1;
  }
  try {
    window?.destroy();
    await fs.rm(path.join(directory, 'profile'), { recursive: true, force: true });
  } catch (error) {
    report.status = 'failed'; report.cleanupError = error.stack || String(error); console.error(error); process.exitCode = 1;
  }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(process.exitCode || 0);
}).catch((error) => {
  console.error('Cue probe could not persist its final report.', error);
  app.exit(1);
});
