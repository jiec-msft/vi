const { app, BrowserWindow, clipboard, systemPreferences, nativeImage, screen, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const readline = require('node:readline');
const { promisify } = require('node:util');
const { recordDesktop } = require('./desktop-evidence.cjs');
const { nodeEvent, createRequest, requestEnvironment, consumeCommitted, executeOwnedDriver, downAuthority,
  armOwnedEarlyInjection, helperCheckpointQueue } = require('./overlay-ci-desktop.cjs');

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.VI_OUTPUT ||
    !process.env.VI_PROVIDER_DIR || !process.argv.includes('--ci-mode=overlay-recovery')) {
  throw new Error('Overlay UI checks require the isolated CI launcher.');
}
const directory = path.resolve(process.env.VI_OUTPUT), profile = path.join(directory, 'profile');
const unavailable = path.join(directory, 'cursor-unavailable');
const desktopArgument = process.argv.find((arg) => arg.startsWith('--ci-owned-desktop='));
const expectedDesktop = desktopArgument?.slice('--ci-owned-desktop='.length);
const receiptArgument = process.argv.find((arg) => arg.startsWith('--ci-desktop-receipt='));
const desktopReceipt = receiptArgument?.slice('--ci-desktop-receipt='.length);
const earlyRecovery = process.argv.includes('--ci-startup-recovery-probe');
let startupRecoveryCompleted = !earlyRecovery;
app.commandLine.appendSwitch('user-data-dir', profile);
app.commandLine.appendSwitch('provider-dir', path.join(directory, 'fixture-provider'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(directory, 'input.wav'));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
  systemPreferences.askForMediaAccess = async (kind) => kind === 'microphone';
}
const report = { platform: process.platform, arch: process.arch, checks: [], helperPids: [],
  mouseScope: 'OS mouse input to owned app window only',
  cursorFailureScope: 'Windows native sampler seam; not a real desktop/RDP transition',
  controlScope: 'physical Stop/Cancel on preview recordings; Ready Start requires an external input target and is not asserted',
  microphoneScope: 'synthetic-input; no service credentials' };
report.causalContext = { sourceHead: process.env.VI_PROBE_HEAD, runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT, caseId: expectedDesktop, callerPid: process.pid };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFile = promisify(childProcess.execFile);
const helpers = [];
const pendingHelperAcks = new WeakMap();
report.helpers = [];
report.pointerStates = [];
report.controlActions = [];
report.osInputs = [];
let mainWindow, overlay, service, stopVideo, held = false;
let ownedDownReceipt;
let shows = 0, hides = 0, focusChanges = 0;
let stage = 'startup';
report.windowEvents = [];
const checkpointQueue = helperCheckpointQueue((file, text) => fs.writeFile(file, text), (helper, error) => {
  helper.proofError = `CI helper checkpoint failed: ${error.message}`; console.error(error);
}, earlyRecovery);
function helperCheckpoint(helper, phase) {
  if (!expectedDesktop) return;
  try {
    checkpointQueue.enqueue(path.join(directory, `helper-state-${helper.role}-${helper.pid}.json`), JSON.stringify({
      phase, at: Date.now(), ticks: process.hrtime.bigint().toString(), clock: 'Node-process-hrtime',
      pid: helper.pid, role: helper.role, generation: helper.generation, requestId: helper.requestId,
      requestNonce: helper.requestNonce, stderrBytes: helper.stderrBytes, stderrTail: helper.stderrTail || '',
      readyCount: helper.events.filter(({ type }) => type === 'ready').length,
      completedAcks: helper.readyAcks.length, proofError: helper.proofError, exit: helper.exit, close: helper.close,
    }, null, 2), helper);
  } catch (error) { helper.proofError = `CI helper checkpoint failed: ${error.message}`; console.error(error); }
}
async function until(action, label, limit = 15000) {
  const deadline = Date.now() + limit;
  do {
    if (await action()) return;
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error(`Overlay evidence deadline: ${label}`);
}
async function collectNativeDesktopReceipts() {
  report.nativeDesktopReceipts = [];
  report.nativeReadyReceipts = [];
  for (const helper of report.helpers) {
    if (helper.proofError) throw new Error(helper.proofError);
    await Promise.all(pendingHelperAcks.get(helper));
    const receipt = helper.readyAcks[0].self.value;
    assert.equal(receipt.pid, helper.pid);
    assert.equal(receipt.role, helper.role);
    assert.equal(receipt.selfQueryComplete, true);
    assert.equal(receipt.station, 'WinSta0');
    assert.equal(receipt.threadDesktop, expectedDesktop);
    assert.equal(receipt.inputDesktop, expectedDesktop);
    report.nativeDesktopReceipts.push(receipt);
    for (const ack of helper.readyAcks) report.nativeReadyReceipts.push(ack.ready.value);
  }
}
const evaluate = (expression) => mainWindow.webContents.executeJavaScript(expression);
const status = async () => {
  for (const helper of report.helpers) if (helper.proofError) throw new Error(helper.proofError);
  const value = await evaluate('window.voice.status()');
  const previous = report.pointerStates.at(-1);
  if (previous?.state !== value.nativePointerState || previous?.restarts !== value.nativePointerRestarts) {
    report.pointerStates.push({ at: Date.now(), stage, state: value.nativePointerState,
      restarts: value.nativePointerRestarts, ready: value.nativePointer });
  }
  return value;
};
async function mouse(mode, point) {
  const location = process.platform === 'win32' ? screen.dipToScreenPoint(point) : point;
  let result;
  if (process.platform === 'darwin' && mode === 'down') held = true;
  const recordInput = (value) => {
    const input = typeof value === 'string' ? JSON.parse(value.trim()) : value;
    report.osInputs.push({ at: Date.now(), stage, mode, ...input, processExitObservedAt: Date.now() });
    if (input.ownedDownInjected && input.ownerVerified && input.leftHeldAfter) {
      held = true;
      ownedDownReceipt = input;
    }
    if (mode === 'up' && input.leftHeldAfter === false) { held = false; ownedDownReceipt = undefined; }
    return input;
  };
  try {
    if (process.platform === 'win32') {
      const handle = overlay.getNativeWindowHandle();
      const id = handle.readBigUInt64LE().toString();
      const request = createRequest(report, 'os-mouse-driver',
        (report.causalRequests || []).filter(({ role }) => role === 'os-mouse-driver').length + 1, expectedDesktop);
      request.jobDirectory = desktopReceipt;
      result = await executeOwnedDriver(report, request, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.resolve('test', 'framework', 'fixtures', 'overlay-mouse.ps1'),
        '-Window', id, '-Foreground', report.windowIds.main, '-Owner', String(process.pid),
        '-Mode', mode, '-X', String(location.x), '-Y', String(location.y),
        '-DesktopName', expectedDesktop, '-JobOutput', desktopReceipt, '-ProofOutput', directory], directory);
    } else {
      result = await execFile(path.resolve('test', 'framework', 'fixtures', 'overlay-mouse'),
        [String(process.pid), mode, String(location.x), String(location.y)], { timeout: 10000 });
    }
  } catch (error) {
    if (error.nativeReceipt) recordInput(error.nativeReceipt);
    else if (error.stdout?.trim()) recordInput(error.stdout);
    throw error;
  }
  const input = recordInput(process.platform === 'win32' ? result : result.stdout);
  assert.equal(input.ownerVerified, true);
  assert.equal(input.foregroundUnchanged, true);
  if (process.platform === 'win32') {
    assert.equal(input.foregroundBefore.window, report.windowIds.main);
    assert.equal(input.foregroundAfter.window, report.windowIds.main);
    assert.equal(input.foregroundBefore.pid, process.pid);
    assert.equal(input.foregroundAfter.pid, process.pid);
    assert.equal(input.overlayNoActivate, true);
    assert.equal(input.overlayNoActivateAfter, true);
  }
  report.osForegroundScope = 'native foreground HWND/application unchanged before and after each OS mouse action';
  if (process.platform === 'darwin' && mode === 'down') held = true;
  if (process.platform === 'darwin' && mode === 'up') held = false;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused !== mainWindow) {
    report.focusFailure = { at: Date.now(), stage, mode, nativeForegroundUnchanged: input.foregroundUnchanged,
      focusedWindow: focused === overlay ? 'overlay' : focused ? 'other-owned' : 'none' };
  }
  assert.equal(focused === mainWindow, true, focused === overlay
    ? 'Floating overlay stole application focus.' : 'Owned application focus baseline changed without focusing the overlay.');
  assert.equal(overlay.isVisible(), true, 'Floating overlay disappeared during OS input.');
}
async function pointFor(selector) {
  const point = await overlay.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
  })()`);
  const bounds = overlay.getBounds();
  return { x: bounds.x + point.x, y: bounds.y + point.y };
}
async function physicalDrag(label) {
  stage = label;
  const before = overlay.getBounds(), point = await pointFor('#drag-handle');
  await mouse('hover', point);
  await pause(200);
  await mouse('down', point);
  await mouse('move', { x: point.x - 10, y: point.y - 6 });
  const target = { x: point.x - 70, y: point.y - 46 };
  await mouse('move', target);
  await until(() => overlay.getBounds().x <= before.x - 40 && overlay.getBounds().y <= before.y - 20, label);
  await mouse('up', target);
  await until(async () => {
    const saved = JSON.parse(await fs.readFile(path.join(profile, 'settings.json')));
    const bounds = overlay.getBounds();
    return saved.overlay?.x === bounds.x && saved.overlay?.y === bounds.y;
  }, 'completed drag persisted');
  report.checks.push(label);
  report[label] = { before, after: overlay.getBounds(), input: process.platform === 'win32' ? 'Win32' : 'CGEvent' };
  await fs.writeFile(path.join(directory, `${label}.png`), (await overlay.webContents.capturePage()).toPNG());
}
async function physicalControls(label) {
  stage = label;
  const changes = { shows, hides, focusChanges };
  const bytes = service.bytes();
  await evaluate('window.voice.toggle()');
  await until(async () => (await status()).phase === 'recording' && service.bytes() > bytes, 'recording before Stop');
  await mouse('click', await pointFor('#stop'));
  await until(async () => (await status()).phase === 'done', 'physical Stop finalization');
  await pause(1200);
  assert.equal((await status()).phase, 'done', 'Duplicate Stop started another recording.');
  await evaluate('window.voice.toggle()');
  await until(async () => (await status()).phase === 'recording', 'recording before physical Cancel');
  const before = await clipboard.readText();
  await mouse('click', await pointFor('#cancel'));
  await until(async () => (await status()).phase === 'idle' && await evaluate('capture === undefined'), 'physical Cancel');
  assert.equal(await clipboard.readText(), before);
  assert.deepEqual({ shows, hides, focusChanges }, changes, 'Ready/Listening controls flashed or activated the overlay.');
  report.checks.push(label, `${label}-no-hide-show-or-focus-change`);
}
const actionCount = (name) => report.controlActions.filter((action) => action.name === name).length;
async function interruptedButton(name) {
  stage = `native-${name}-interrupted-before-release`;
  const count = actionCount(name), helperCount = helpers.length;
  await evaluate('window.voice.toggle()');
  await until(async () => (await status()).phase === 'recording', `recording before interrupted ${name}`);
  const point = await pointFor(`#${name}`);
  await mouse('hover', point);
  await mouse('down', point);
  const terminal = name === 'stop' ? 'done' : 'idle';
  await until(async () => (await status()).phase === terminal && await evaluate('capture === undefined'),
    `native ${name} action completed before release`);
  assert.equal(actionCount(name), count + 1);
  await fs.writeFile(unavailable, 'cursor sampling unavailable');
  await until(async () => (await status()).nativePointerState === 'suspended', `native ${name} press interrupted`);
  await mouse('up', point);
  await pause(200);
  assert.equal(actionCount(name), count + 1, `Interrupted ${name} dispatched again on DOM click.`);
  assert.equal((await status()).phase, terminal);
  assert.equal(overlay.isVisible(), true);
  report.checks.push(`${name}-physical-press-owned-across-native-suspension`);
  const fallback = name === 'stop' ? 'cancel' : 'stop', fallbackCount = actionCount(fallback);
  stage = `fresh-fallback-${fallback}-after-interrupted-${name}`;
  await evaluate('window.voice.toggle()');
  await until(async () => (await status()).phase === 'recording', `recording before fresh fallback ${fallback}`);
  const next = await pointFor(`#${fallback}`);
  await mouse('hover', next);
  await mouse('click', next);
  await until(async () => (await status()).phase === (fallback === 'stop' ? 'done' : 'idle'),
    `fresh fallback ${fallback} completed`);
  assert.equal(actionCount(fallback), fallbackCount + 1);
  assert.equal((await status()).nativePointerState, 'suspended');
  assert.equal(helpers.length, helperCount);
  report.checks.push(`fresh-fallback-${fallback}-not-suppressed-after-interrupted-${name}`);
  await fs.unlink(unavailable);
  await until(async () => (await status()).nativePointer, `native pointer resumed after interrupted ${name}`);
}
function markerVisible(png, cyan = false) {
  const image = nativeImage.createFromBuffer(png), pixels = image.toBitmap();
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] > 180 && (cyan ? pixels[offset + 1] > 180 && pixels[offset + 2] < 80
      : pixels[offset + 1] < 80 && pixels[offset + 2] > 180)) count++;
  }
  return count >= 8;
}
async function run() {
  assert.equal(process.arch, process.env.VI_EXPECTED_ARCH);
  const provider = path.resolve(process.env.VI_PROVIDER_DIR);
  service = await require(path.join(provider, 'fixtures', 'provider-service.cjs')).createService();
  const fixture = path.join(directory, 'fixture-provider');
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(fixture, 'plugin.json'), JSON.stringify({
    id: 'fixture.service', kind: 'service-provider', apiVersion: 1, entry: 'index.cjs',
  }));
  await fs.writeFile(path.join(fixture, 'config.json'), JSON.stringify({ endpoint: service.endpoint }));
  await fs.writeFile(path.join(fixture, 'index.cjs'),
    `exports.createSession = options => require(${JSON.stringify(path.join(provider, 'src', 'providers', 'index.cjs'))})` +
    `.createSession({...options, credentialSource: async () => ({token:'fixture-credential'})});\n`);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    consent: true, sounds: false, openAtLogin: false, autoCopy: false,
    shortcut: 'CommandOrControl+Alt+Shift+F9', cancelShortcut: 'CommandOrControl+Alt+Shift+F10',
  }));
  let helperFile;
  let deliveryFile;
  if (process.platform === 'win32') {
    const original = await fs.readFile(path.resolve('native', 'windows-overlay.ps1'), 'utf8');
    const seam = `
    static bool ReadCursor(out POINT point) {
        point = new POINT();
        return !System.IO.File.Exists(${JSON.stringify(unavailable)}) && GetCursorPos(out point);
    }
`;
    assert.ok(original.includes('if (!GetCursorPos(out point))'));
    let injected = original.replace('    POINT last;', `    POINT last;${seam}`)
      .replace('if (!GetCursorPos(out point))', 'if (!ReadCursor(out point))');
    if (expectedDesktop) {
      const quote = (value) => `'${value.replace(/'/g, "''")}'`;
      const attest = (role) => `& ${quote(path.resolve('scripts', 'overlay-ci-desktop-attest.ps1'))} -DesktopName ${quote(expectedDesktop)} -Output ${quote(directory)} -JobOutput ${quote(desktopReceipt)} -Role ${role} -Generation $env:VI_CI_NATIVE_GENERATION`;
      injected = injected.replace("$ErrorActionPreference = 'Stop'", `$ErrorActionPreference = 'Stop'\n${attest('overlay-pointer')}`);
      injected = injected.replace('return !System.IO.File.Exists(', `bool confirmed = false;
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
            var attestor = assembly.GetType("OverlayDesktopAttestor");
            if (attestor != null) { attestor.GetMethod("ConfirmExecution").Invoke(null, null); confirmed = true; break; }
        }
        if (!confirmed) throw new InvalidOperationException("Native execution attestor unavailable.");
        return !System.IO.File.Exists(`);
      assert.ok(injected.includes('if (value != null) Console.WriteLine(value);'));
      injected = injected.replace('    POINT last;', `    POINT last;
    static void WriteSample(string value) {
        bool ready = value == "{\\"type\\":\\"ready\\"}";
        Type attestor = null;
        if (ready) {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
                attestor = assembly.GetType("OverlayDesktopAttestor");
                if (attestor != null) break;
            }
            if (attestor == null) throw new InvalidOperationException("Native READY attestor unavailable.");
            attestor.GetMethod("BeginReadyWrite").Invoke(null, new object[] { value });
        }
        Console.WriteLine(value);
        if (ready) attestor.GetMethod("EndReadyWrite").Invoke(null, new object[] { value });
    }`)
        .replace('if (value != null) Console.WriteLine(value);', 'if (value != null) WriteSample(value);');
      const delivery = await fs.readFile(path.resolve('native', 'windows-delivery.ps1'), 'utf8');
      deliveryFile = path.join(directory, 'windows-delivery-ci.ps1');
      await fs.writeFile(deliveryFile, delivery.replace("$ErrorActionPreference = 'Stop'",
        `$ErrorActionPreference = 'Stop'\n${attest('desktop-delivery')}`)
        .replace("(Join-Path $PSScriptRoot 'windows-input.ps1')", quote(path.resolve('native', 'windows-input.ps1')))
        .replace('while ($null -ne ($line = [VoiceCommands]::ReadNext()))',
          '[OverlayDesktopAttestor]::ConfirmExecution()\nwhile ($null -ne ($line = [VoiceCommands]::ReadNext()))')
        .replace('@{ id = $request.id; ok = $true; value = $value } | ConvertTo-Json -Compress -Depth 5',
          `$ciReply = @{ id = $request.id; ok = $true; value = $value } | ConvertTo-Json -Compress -Depth 5
        if ($request.action -eq 'ready') {
            [OverlayDesktopAttestor]::BeginReadyWrite($ciReply)
            [Console]::WriteLine($ciReply)
            [OverlayDesktopAttestor]::EndReadyWrite($ciReply)
        } else { $ciReply }`));
    }
    helperFile = path.join(directory, 'windows-overlay-ci.ps1');
    await fs.writeFile(helperFile, injected);
  }
  const spawn = childProcess.spawn;
  childProcess.spawn = (file, args, options) => {
    const pointer = args?.some((arg) => typeof arg === 'string' && arg.endsWith('windows-overlay.ps1'));
    const delivery = file.endsWith('macos-delivery') ||
      args?.some((arg) => typeof arg === 'string' && arg.endsWith('windows-delivery.ps1'));
    const actual = pointer ? args.map((arg) => arg.endsWith('windows-overlay.ps1') ? helperFile : arg)
      : delivery && deliveryFile ? args.map((arg) => arg.endsWith('windows-delivery.ps1') ? deliveryFile : arg) : args;
    const role = pointer ? 'overlay-pointer' : 'desktop-delivery';
    const generation = report.helpers.filter((value) => value.role === role).length + 1;
    const request = pointer || delivery ? createRequest(report, role, generation, expectedDesktop) : undefined;
    const requestSequence = request?.requestSequence, requestId = request?.requestId;
    const spawnStartedAt = Date.now(), spawnStartedTicks = process.hrtime.bigint().toString();
    const child = spawn(file, actual, expectedDesktop && (pointer || delivery)
      ? { ...options, env: requestEnvironment(request, options?.env || process.env) } : options);
    const spawnReturnedAt = Date.now(), spawnReturnedTicks = process.hrtime.bigint().toString();
    if (request) {
      request.returnedPid = child.pid; request.jobDirectory = desktopReceipt;
      request.returned = nodeEvent(report, 'request-return', { requestId, pid: child.pid });
    }
    if (pointer) {
      helpers.push(child);
      report.helperPids.push(child.pid);
    }
    if (pointer || delivery) {
      const helper = { role, pid: child.pid, generation,
        startedAt: Date.now(), helperStartedTicks: process.hrtime.bigint().toString(), stage, events: [], stderrBytes: 0,
        requestId, requestSequence, callerPid: process.pid, requestNonce: request.requestNonce, causalRequest: request,
        readyAcks: [], spawnStartedAt, spawnStartedTicks,
        spawnReturnedAt, spawnReturnedTicks, returnedPid: child.pid,
        spawnClock: 'Node-process-hrtime', startedAtClock: 'Node-Date.now-not-native-FILETIME',
        startedAtMeaning: 'observer-after-synchronous-spawn-return-before-spawn-event' };
      report.helpers.push(helper);
      pendingHelperAcks.set(helper, []);
      helperCheckpoint(helper, 'returned-pid');
      child.once('spawn', () => {
        helper.spawnObservedAt = Date.now();
        helper.spawnObservedTicks = process.hrtime.bigint().toString();
        request.spawn = nodeEvent(report, 'process-spawn', { requestId, pid: child.pid });
        helperCheckpoint(helper, 'process-spawn');
      });
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      let receiveOrder = 0, readySequence = 0;
      lines.on('line', (line) => {
        receiveOrder++;
        const type = line.match(/"type":"(ready|cancel|suspended)"/)?.[1];
        if (type || line.includes('"ready":true')) {
          const eventType = type || 'ready';
          const causal = nodeEvent(report, 'helper-line', { requestId, type: eventType, receiveOrder });
          const event = { type: eventType, at: Date.now(), stage, message: line, receiveOrder, causal,
            receivedTicks: process.hrtime.bigint().toString(), monotonicClock: 'Node-process-hrtime-not-native-stopwatch',
            ...(eventType === 'ready' ? { readySequence: ++readySequence } : {}) };
          helper.events.push(event);
          if (pointer && eventType === 'ready' && earlyRecovery) {
            if (helpers.length === 1 && !helper.startupFailureScheduled) {
              armOwnedEarlyInjection(helper, request, report, child, event, () => {
                checkpointQueue.release(); helperCheckpoint(helper, 'owned-injection');
              });
            } else if (helpers.length === 2) startupRecoveryCompleted = true;
          }
          helperCheckpoint(helper, 'native-line');
          if (eventType === 'ready' && expectedDesktop) {
            const deadlineTicks = BigInt(causal.ticks) + 300000000n;
            const ackPromise = (async () => {
              while (true) {
                try {
                  const self = await consumeCommitted(directory, `desktop-${role}-${child.pid}`, request, report);
                  const ready = await consumeCommitted(directory, `desktop-ready-${role}-${child.pid}-${event.readySequence}`, request, report);
                  const acknowledged = nodeEvent(report, 'helper-ready-ack', { requestId, readySequence: event.readySequence });
                  assert.ok(BigInt(acknowledged.ticks) < deadlineTicks, 'Completed READY sidecar ACK missed the original deadline.');
                  const ack = { self, ready, acknowledged, readySequence: event.readySequence };
                  helper.readyAcks.push(ack);
                  helperCheckpoint(helper, 'committed-sidecar-ack');
                  return ack;
                } catch (error) {
                  if (error.code !== 'ENOENT' || process.hrtime.bigint() >= deadlineTicks) throw error;
                  await pause(5);
                }
              }
            })();
            pendingHelperAcks.get(helper).push(ackPromise);
            ackPromise.catch((error) => { helper.proofError = error.message; helperCheckpoint(helper, 'ack-failed'); });
          }
        }
        if (line.includes('"ok":false')) helper.events.push({ type: 'request-failed', at: Date.now(), stage });
      });
      child.stderr.on('data', (bytes) => {
        helper.stderrBytes += bytes.length;
        helper.stderrTail = ((helper.stderrTail || '') + bytes.toString('utf8')).slice(-8192);
        helperCheckpoint(helper, 'native-stderr');
      });
      child.once('error', () => { helper.errorAt = Date.now(); });
      child.once('exit', (code, signal) => {
        helper.exit = { at: Date.now(), code, signal, stage, causal: nodeEvent(report, 'process-exit', { requestId, code, signal }) };
        helperCheckpoint(helper, 'actual-exit');
      });
      child.once('close', (code, signal) => {
        helper.closedAt = Date.now(); helper.close = nodeEvent(report, 'process-close', { requestId, code, signal }); lines.close();
        helperCheckpoint(helper, 'actual-close');
        if (pointer && helpers[0] === child && !helper.startupFailureScheduled) checkpointQueue.release();
      });
    }
    return child;
  };
  const installHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => installHandle(channel, (event, ...args) => {
    if (event.sender === overlay?.webContents && ['overlay-stop', 'cancel'].includes(channel)) {
      report.controlActions.push({ name: channel === 'overlay-stop' ? 'stop' : 'cancel', at: Date.now(), stage });
    }
    return listener(event, ...args);
  });
  require('../app/main.cjs');
  await app.whenReady();
  await until(async () => {
    mainWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'));
    overlay = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/overlay.html'));
    return startupRecoveryCompleted && mainWindow && overlay && (!expectedDesktop || mainWindow.isVisible()) && overlay.isVisible() && (await status()).shortcutReady &&
      (process.platform !== 'win32' || (await status()).nativePointer);
  }, 'full application and native pointer startup', 35000);
  checkpointQueue.release();
  report.initialPointerRestarts = (await status()).nativePointerRestarts;
  if (earlyRecovery) {
    assert.equal(report.initialPointerRestarts, 1);
    assert.equal(helpers.length, 2);
    const failed = report.helpers.find((helper) => helper.pid === helpers[0].pid);
    const recovered = report.helpers.find((helper) => helper.pid === helpers[1].pid);
    assert.equal(failed.ownedStartupFailureInjected, true);
    assert.ok(failed.exit && failed.closedAt);
    assert.ok(recovered.events.some((event) => event.type === 'ready'));
    report.startupRecovery = { failedPid: helpers[0].pid, recoveredPid: helpers[1].pid,
      injectedAt: failed.startupFailureRequestedAt, failedExitAt: failed.exit.at,
      recoveredReadyAt: recovered.events.find((event) => event.type === 'ready').at,
      injection: failed.injection, failedExit: failed.exit.causal, failedClose: failed.close,
      recoveredReady: recovered.events.find((event) => event.type === 'ready').causal };
    report.checks.push('early-owned-helper-exit-recovery-before-root-readiness');
  }
  if (process.platform === 'win32') {
    report.windowIds = { owner: process.pid,
      main: mainWindow.getNativeWindowHandle().readBigUInt64LE().toString(),
      overlay: overlay.getNativeWindowHandle().readBigUInt64LE().toString() };
  }
  mainWindow.focus();
  await until(() => BrowserWindow.getFocusedWindow() === mainWindow, 'owned focus baseline');
  assert.equal(overlay.isFocusable(), false);
  const windowEvent = (event) => report.windowEvents.push({ event, stage, at: Date.now(), visible: overlay.isVisible() });
  overlay.on('show', () => { shows++; windowEvent('show'); });
  overlay.on('hide', () => { hides++; windowEvent('hide'); });
  overlay.on('focus', () => { focusChanges++; windowEvent('focus'); });
  await overlay.webContents.executeJavaScript(`(() => {
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;right:4px;bottom:4px;width:14px;height:14px;background:#ff00ff;pointer-events:none;z-index:2147483647';
    document.body.append(marker);
  })()`);
  if (expectedDesktop) {
    await mainWindow.webContents.executeJavaScript(`(() => {
      const marker = document.createElement('div');
      marker.style.cssText = 'position:fixed;left:4px;top:4px;width:14px;height:14px;background:#00ffff;pointer-events:none;z-index:2147483647';
      document.body.append(marker);
    })()`);
    let mainCapture, overlayCapture;
    await until(async () => {
      mainCapture = (await mainWindow.webContents.capturePage()).toPNG();
      overlayCapture = (await overlay.webContents.capturePage()).toPNG();
      report.renderEvidence = { coverage: 'compositor-output-not-all-process-threads',
        roleSource: 'Electron-app-metrics-self-reported', mainCaptureBytes: mainCapture.length,
        overlayCaptureBytes: overlayCapture.length, desktopMarkerSamples: 0,
        mainMarkerVisible: markerVisible(mainCapture, true), overlayMarkerVisible: markerVisible(overlayCapture) };
      return report.renderEvidence.mainMarkerVisible && report.renderEvidence.overlayMarkerVisible;
    }, 'both owned root window markers painted before readiness', 5000);
    assert.equal(report.renderEvidence.mainMarkerVisible, true);
    assert.equal(report.renderEvidence.overlayMarkerVisible, true);
    await fs.writeFile(path.join(directory, 'main-render.png'), mainCapture);
    await fs.writeFile(path.join(directory, 'overlay-render.png'), overlayCapture);
    assert.ok(desktopReceipt);
    report.rootReadyAt = Date.now();
    report.rootReadyEvent = nodeEvent(report, 'root-ready');
    await fs.writeFile(path.join(desktopReceipt, 'ready.tmp'), JSON.stringify({ pid: process.pid, desktop: expectedDesktop,
      mainWindow: report.windowIds.main, overlayWindow: report.windowIds.overlay }));
    await fs.rename(path.join(desktopReceipt, 'ready.tmp'), path.join(desktopReceipt, 'ready.json'));
    report.desktopScope = 'ordinary owned CI desktop; not default user desktop acceptance';
  }
  stopVideo = await recordDesktop(directory, (png) => {
    const visible = markerVisible(png);
    if (!visible) writeFileSync(path.join(directory, 'obscured-desktop.png'), png);
    assert.ok(visible, 'Overlay obscured in desktop evidence.');
    if (expectedDesktop) {
      assert.ok(markerVisible(png, true), 'Main render marker missing from whole-desktop evidence.');
      report.renderEvidence.desktopMarkerSamples++;
    }
  });
  await pause(500);
  report.startupVisibilityEvents = { shows, hides, focusChanges };
  assert.equal(hides, 0, 'Overlay disappeared while establishing the startup baseline.');
  shows = hides = focusChanges = 0;
  if (process.argv.includes('--ci-desktop-timeout-probe')) {
    assert.ok(expectedDesktop && desktopReceipt);
    await mouse('hover', await pointFor('#drag-handle'));
    const witnessRequest = createRequest(report, 'os-mouse-driver',
      report.causalRequests.filter(({ role }) => role === 'os-mouse-driver').length + 1, expectedDesktop);
    witnessRequest.jobDirectory = desktopReceipt;
    const witness = await executeOwnedDriver(report, witnessRequest, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve('test', 'framework', 'fixtures', 'overlay-mouse.ps1'),
      '-Window', report.windowIds.overlay, '-Owner', String(process.pid), '-Mode', 'status',
      '-DesktopName', expectedDesktop, '-JobOutput', desktopReceipt, '-ProofOutput', directory], directory);
    report.timeoutWitness = witness;
    report.osInputs.push({ mode: 'status', ...report.timeoutWitness, processExitObservedAt: Date.now() });
    assert.equal(report.timeoutWitness.leftHeldBefore, false);
    assert.equal(report.timeoutWitness.leftHeldAfter, false);
    assert.equal(report.timeoutWitness.releaseSent, false);
    await collectNativeDesktopReceipts();
    report.electronProcesses = app.getAppMetrics().map(({ pid, type, creationTime }) => ({ pid, type, creationTime }));
    Object.assign(report, await stopVideo());
    stopVideo = undefined;
    report.status = 'timeout-witness-ready';
    report.timeoutScope = 'intentional stall before any owned press; no guarantee for a killed root with unknown held input';
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(desktopReceipt, 'timeout-ready.json'), JSON.stringify({ pid: process.pid,
      desktop: expectedDesktop, leftHeld: false }));
    await new Promise(() => {});
  }
  await physicalDrag('physical-drag');
  await physicalControls('physical-stop-cancel');
  if (process.platform === 'win32') {
    stage = 'fallback-hover-before-native-readiness';
    await fs.writeFile(unavailable, 'cursor sampling unavailable');
    await until(async () => (await status()).nativePointerState === 'suspended', 'fallback before native readiness');
    await mouse('hover', await pointFor('#drag-handle'));
    await fs.unlink(unavailable);
    await until(async () => (await status()).nativePointer, 'native ready after uncaptured DOM hover');
    stage = 'native-cursor-suspension';
    let point = await pointFor('#drag-handle');
    await mouse('hover', point);
    await mouse('down', point);
    await mouse('move', { x: point.x - 20, y: point.y - 10 });
    await fs.writeFile(unavailable, 'cursor sampling unavailable');
    await until(async () => (await status()).nativePointerState === 'suspended', 'temporary cursor suspension');
    const suspended = overlay.getBounds(), helperCount = helpers.length;
    await mouse('move', { x: point.x - 35, y: point.y - 18 });
    await mouse('move', { x: point.x - 45, y: point.y - 25 });
    assert.equal((await status()).nativePointerState, 'suspended');
    assert.deepEqual(overlay.getBounds(), suspended, 'Fallback restarted the cancelled held gesture during suspension.');
    report.checks.push('uncaptured-hover-cleared-on-native-readiness', 'suspended-fallback-cannot-restart-held-drag');
    await fs.unlink(unavailable);
    await until(async () => (await status()).nativePointer, 'same helper resumed');
    await mouse('move', { x: point.x - 45, y: point.y - 25 });
    assert.deepEqual(overlay.getBounds(), suspended, 'Cancelled gesture resumed while the button remained held.');
    await mouse('up', { x: point.x - 45, y: point.y - 25 });
    assert.equal(helpers.length, helperCount, 'Temporary cursor failure restarted the helper.');
    report.checks.push('native-cursor-suspend-cancels-held-drag', 'native-cursor-resume-without-restart');
    await physicalDrag('physical-drag-after-cursor-resume');
    await interruptedButton('cancel');
    await interruptedButton('stop');
    stage = 'owned-helper-death';
    point = await pointFor('#drag-handle');
    await mouse('hover', point);
    await mouse('down', point);
    const beforeDeath = helpers.length;
    helpers.at(-1).kill();
    await until(async () => !(await status()).nativePointer, 'helper death clears readiness');
    await until(async () => (await status()).nativePointer && helpers.length === beforeDeath + 1, 'owned helper recovered');
    const recovered = overlay.getBounds();
    await mouse('move', { x: point.x - 30, y: point.y - 20 });
    assert.deepEqual(overlay.getBounds(), recovered, 'Dead helper gesture survived recovery.');
    await mouse('up', { x: point.x - 30, y: point.y - 20 });
    await physicalDrag('physical-drag-after-helper-recovery');
    report.checks.push('owned-helper-death-recovery-cancels-gesture');
    stage = 'native-retry-budget';
    for (let count = helpers.length; count <= 4; count++) {
      helpers.at(-1).kill();
      if (count < 4) await until(async () => (await status()).nativePointer && helpers.length === count + 1, 'bounded retry');
      else await until(async () => (await status()).nativePointerState === 'unavailable', 'retry budget exhausted');
    }
    const exhausted = await status();
    assert.equal(exhausted.nativePointer, false);
    assert.equal(exhausted.nativePointerRestarts, 3);
    assert.match(exhausted.overlayControlError, /Restart the app/);
    await pause(3500);
    assert.equal(helpers.length, 4, 'Automatic restarts exceeded the lifetime budget.');
    report.checks.push('native-recovery-bounded-to-three-restarts');
    await physicalDrag('physical-drag-fallback-after-helper-death');
    await physicalControls('fallback-physical-stop-cancel');
  } else {
    report.checks.push('macOS-DOM-fallback-physical-input');
    report.cursorFailureScope = 'not applicable; Windows native helper only';
  }
  report.visibilityEvents = { shows, hides, focusChanges };
  assert.equal(shows, 0);
  assert.equal(hides, 0);
  assert.equal(focusChanges, 0);
  report.finalPointerState = (await status()).nativePointerState;
  if (expectedDesktop) {
    await collectNativeDesktopReceipts();
    report.electronProcesses = app.getAppMetrics().map(({ pid, type, creationTime }) => ({ pid, type, creationTime }));
  }
  report.status = 'passed';
}
run().catch((error) => {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
  console.error(error.stack);
}).finally(async () => {
  const cleanupFailure = (stage, error) => {
    report.status = 'failed'; process.exitCode = 1;
    (report.cleanupErrors ||= []).push({ stage, error: error.message });
    console.error(error.stack);
  };
  try {
    if (held && overlay && !overlay.isDestroyed()) {
      if (process.platform === 'win32') {
        if (!ownedDownReceipt) throw new Error('Owned down receipt missing; mouse cleanup authority cannot be verified.');
        let result;
        try {
          const request = createRequest(report, 'os-mouse-driver',
            report.causalRequests.filter(({ role }) => role === 'os-mouse-driver').length + 1, expectedDesktop);
          request.jobDirectory = desktopReceipt;
          result = await executeOwnedDriver(report, request, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', path.resolve('test', 'framework', 'fixtures', 'overlay-mouse.ps1'),
            '-Window', ownedDownReceipt.ownedWindow, '-Owner', String(process.pid), '-Mode', 'up',
            '-CleanupOwnedDown', '-OwnedDownReceipt', JSON.stringify(downAuthority(ownedDownReceipt)),
            '-DesktopName', expectedDesktop, '-JobOutput', desktopReceipt, '-ProofOutput', directory], directory);
        } catch (error) {
          if (error.nativeReceipt) report.cleanupRelease = error.nativeReceipt;
          report.cleanupBlocked = { reason: error.message, remainingHeld: report.cleanupRelease?.leftHeldAfter ?? 'unknown' };
          throw error;
        }
        report.cleanupRelease = result;
        report.cleanupRelease.processExitObservedAt = Date.now();
        assert.equal(report.cleanupRelease.cleanupUpOnly, true);
        assert.equal(report.cleanupRelease.leftHeldAfter, false);
        held = false;
        ownedDownReceipt = undefined;
      } else {
        await mouse('up', screen.getCursorScreenPoint());
      }
    } else if (held) {
      report.cleanupBlocked = { reason: 'original owned window no longer live', remainingHeld: true };
      throw new Error('Owned mouse cleanup could not validate the destroyed original window.');
    }
  } catch (error) { cleanupFailure('mouse-release', error); }
  try { if (stopVideo) Object.assign(report, await stopVideo()); }
  catch (error) { cleanupFailure('desktop-video', error); }
  try { await service?.close(); }
  catch (error) { cleanupFailure('service', error); }
  try {
    await checkpointQueue.flush();
    for (const helper of report.helpers) if (helper.proofError) throw new Error(helper.proofError);
  } catch (error) { cleanupFailure('helper-checkpoint', error); }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
});
