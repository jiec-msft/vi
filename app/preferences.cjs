const APP_ID = 'com.jiec.vi';
const { pluginPreferences } = require('./plugins/manifest.cjs');

const DEFAULTS = Object.freeze({
  consent: false,
  mode: 'final',
  triggerMode: 'toggle',
  deviceId: '',
  autoCopy: false,
  sounds: true,
  caretIndicator: false,
  openAtLogin: true,
  shortcut: 'CommandOrControl+Shift+Space',
  cancelShortcut: 'CommandOrControl+Shift+Backspace',
});

function accelerator(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Provide a shortcut such as Ctrl+Shift+Space.');
  const aliases = { ctrl: 'Control', control: 'Control', cmd: 'Command', command: 'Command',
    cmdorctrl: platform === 'darwin' ? 'Command' : 'Control',
    commandorcontrol: platform === 'darwin' ? 'Command' : 'Control',
    alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super' };
  const parts = value.split('+').map((part) => part.trim());
  const key = parts.pop();
  const modifiers = parts.map((part) => aliases[part.toLowerCase()]);
  if (!key || modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length ||
      !modifiers.some((part) => part !== 'Shift')) {
    throw new Error('Use Control/Cmd/Alt with one key; duplicate or unknown modifiers are not allowed.');
  }
  const names = { space: 'Space', backspace: 'Backspace', enter: 'Enter', escape: 'Escape',
    tab: 'Tab', delete: 'Delete', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
  const normalized = names[key.toLowerCase()] || (/^(?:[a-z0-9]|F(?:[1-9]|1\d|2[0-4]))$/i.test(key) && key.toUpperCase());
  if (!normalized) throw new Error('Use a letter, digit, function key, Space, Backspace, or navigation key.');
  const order = ['Command', 'Control', 'Alt', 'Shift', 'Super'];
  return [...modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b)), normalized].join('+');
}

function preferences(saved = {}, platform = process.platform) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings object.');
  const next = { ...DEFAULTS };
  next.plugins = pluginPreferences(saved.plugins);
  for (const key of ['consent', 'autoCopy', 'sounds', 'openAtLogin', 'caretIndicator']) {
    if (saved[key] !== undefined) {
      if (typeof saved[key] !== 'boolean') throw new Error(`Invalid ${key} setting.`);
      next[key] = saved[key];
    }
  }
  if (saved.mode !== undefined && !['streaming', 'final'].includes(saved.mode)) throw new Error('Invalid insertion mode.');
  // Earlier profiles used live replacement. Migrate to final-result delivery.
  next.mode = 'final';
  if (saved.triggerMode !== undefined && !['toggle', 'push-to-talk'].includes(saved.triggerMode)) {
    throw new Error('Invalid recording shortcut mode.');
  }
  next.triggerMode = saved.triggerMode ?? next.triggerMode;
  if (saved.deviceId !== undefined && (typeof saved.deviceId !== 'string' || saved.deviceId.length > 512 ||
      /[\x00-\x1f]/u.test(saved.deviceId))) throw new Error('Invalid input device.');
  next.deviceId = saved.deviceId ?? '';
  next.shortcut = accelerator(saved.shortcut ?? next.shortcut, platform);
  next.cancelShortcut = accelerator(saved.cancelShortcut ?? next.cancelShortcut, platform);
  if (next.shortcut === next.cancelShortcut) throw new Error('Record and cancel shortcuts must be different.');
  if (saved.overlay !== undefined) {
    if (!saved.overlay || !Number.isInteger(saved.overlay.x) || !Number.isInteger(saved.overlay.y)) {
      throw new Error('Invalid floating window position.');
    }
    next.overlay = { x: saved.overlay.x, y: saved.overlay.y };
  }
  return next;
}

function overlayPosition(saved, displays, width = 224, height = 54) {
  const area = displays.find(({ workArea: a }) => saved && saved.x >= a.x && saved.y >= a.y &&
    saved.x + width <= a.x + a.width && saved.y + height <= a.y + a.height)?.workArea;
  if (area) return { x: saved.x, y: saved.y };
  const primary = displays[0].workArea;
  return { x: Math.round(primary.x + (primary.width - width) / 2),
    y: primary.y + primary.height - height - 24 };
}

function applyLoginSettings(app, settings, isolated, platform = process.platform) {
  if (isolated) return false;
  const options = { path: app.getPath('exe'), args: ['--background'] };
  const desired = settings.consent && settings.openAtLogin;
  app.setLoginItemSettings({ ...options, openAtLogin: desired, ...(platform === 'win32' ? { name: APP_ID } : {}) });
  const result = app.getLoginItemSettings(options);
  if (platform === 'win32' && !Array.isArray(result.launchItems)) {
    throw new Error('Could not verify the Windows login item.');
  }
  // openAtLogin checks the requested args; Electron 45 may omit them from launchItems.args.
  const actual = platform === 'win32'
    ? result.openAtLogin === true && result.launchItems.some((item) => item.name === APP_ID &&
      item.scope === 'user' && item.enabled === true && typeof item.path === 'string' &&
      item.path.toLowerCase() === options.path.toLowerCase())
    : result.openAtLogin;
  if (actual !== desired) throw new Error('The OS blocked start-at-login. Check startup/background-app permissions.');
  return actual;
}

module.exports = { APP_ID, DEFAULTS, accelerator, preferences, overlayPosition, applyLoginSettings };
