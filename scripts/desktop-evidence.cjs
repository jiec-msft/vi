const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function recordDesktop(directory, verifyFrame = () => {}) {
  const recorder = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve('src', 'recorder-preload.cjs'), sandbox: true,
    contextIsolation: true, backgroundThrottling: false,
  } });
  const chunks = [];
  let complete, inFlight, captureError;
  const completed = new Promise((resolve) => { complete = resolve; });
  const chunk = (event, bytes) => {
    if (event.sender === recorder.webContents) chunks.push(Buffer.from(bytes));
  };
  const done = (event) => { if (event.sender === recorder.webContents) complete(); };
  ipcMain.on('video-chunk', chunk);
  ipcMain.on('video-done', done);
  const screenshot = async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 } });
    assert.ok(sources[0] && !sources[0].thumbnail.isEmpty(), 'Desktop capture unavailable.');
    return sources[0].thumbnail.toPNG();
  };
  await recorder.loadFile(path.resolve('src', 'recorder.html'));
  const capture = async () => {
    const png = await screenshot();
    recorder.webContents.send('frame', png);
    verifyFrame(png);
  };
  await capture();
  const timer = setInterval(() => {
    if (!inFlight) inFlight = capture().catch((error) => { captureError = error; })
      .finally(() => { inFlight = undefined; });
  }, 200);
  return async () => {
    clearInterval(timer);
    let deadline;
    try {
      await inFlight;
      recorder.webContents.send('stop-video');
      await Promise.race([completed, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Desktop recorder did not finish.')), 5000);
      })]);
      const video = Buffer.concat(chunks);
      assert.ok(video.length > 0, 'Desktop video is empty.');
      await fs.writeFile(path.join(directory, 'desktop.webm'), video);
      await fs.writeFile(path.join(directory, 'desktop.png'), await screenshot());
      if (captureError) throw captureError;
      return { videoScope: 'desktop', videoBytes: video.length };
    } finally {
      clearTimeout(deadline);
      ipcMain.removeListener('video-chunk', chunk);
      ipcMain.removeListener('video-done', done);
      recorder.destroy();
    }
  };
}
module.exports = { recordDesktop };
