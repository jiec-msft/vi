class ShortcutBindings {
  constructor(api, toggle, cancel) {
    this.api = api;
    this.toggle = toggle;
    this.cancel = cancel;
    this.current = [];
  }

  check(shortcuts) {
    const temporary = [];
    try {
      for (const shortcut of shortcuts) {
        if (this.current.includes(shortcut)) continue;
        if (!this.api.register(shortcut, () => {})) {
          throw new Error(`${shortcut} is in use by another app or reserved by the OS. Choose another shortcut.`);
        }
        temporary.push(shortcut);
      }
    } finally {
      for (const shortcut of temporary) this.api.unregister(shortcut);
    }
  }

  install(shortcuts) {
    this.check(shortcuts);
    const previous = this.current;
    for (const shortcut of previous) this.api.unregister(shortcut);
    this.current = [];
    try {
      for (let i = 0; i < shortcuts.length; i++) {
        if (!this.api.register(shortcuts[i], i === 0 ? this.toggle : this.cancel)) {
          throw new Error(`${shortcuts[i]} could not be registered; it may now be in use.`);
        }
        this.current.push(shortcuts[i]);
      }
    } catch (error) {
      for (const shortcut of this.current) this.api.unregister(shortcut);
      this.current = [];
      for (let i = 0; i < previous.length; i++) {
        if (this.api.register(previous[i], i === 0 ? this.toggle : this.cancel)) this.current.push(previous[i]);
      }
      if (this.current.length !== previous.length) {
        for (const shortcut of this.current) this.api.unregister(shortcut);
        this.current = [];
        throw new Error(`${error.message} Previous shortcuts could not be restored; reopen settings.`);
      }
      throw error;
    }
  }
}

function shortcutKeys(shortcut, platform = process.platform) {
  const windows = { Control: 17, Shift: 16, Alt: 18, Super: 91, Space: 32, Backspace: 8, Enter: 13,
    Escape: 27, Tab: 9, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
    Up: 38, Down: 40, Left: 37, Right: 39 };
  const mac = { Command: 55, Control: 59, Shift: 56, Alt: 58, Super: 55, Space: 49, Backspace: 51,
    Enter: 36, Escape: 53, Tab: 48, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121,
    Up: 126, Down: 125, Left: 123, Right: 124 };
  const letters = { A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11,
    Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22,
    '5': 23, '9': 25, '7': 26, '8': 28, '0': 29, O: 31, U: 32, I: 34, P: 35, L: 37,
    J: 38, K: 40, N: 45, M: 46 };
  const functions = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90];
  return shortcut.split('+').map((part) => {
    const code = platform === 'win32' ? windows[part] ??
      (/^[A-Z0-9]$/.test(part) ? part.charCodeAt(0) : /^F\d+$/.test(part) ? 111 + Number(part.slice(1)) : undefined)
      : mac[part] ?? letters[part] ?? (/^F\d+$/.test(part) ? functions[Number(part.slice(1)) - 1] : undefined);
    if (code === undefined) throw new Error('This shortcut cannot be monitored for key release on this platform.');
    return code;
  });
}

class ShortcutPress {
  constructor({ held, press, release, failure }) {
    Object.assign(this, { held, press, release, failure });
  }
  down(keys) {
    if (this.pressed) return;
    this.pressed = true;
    this.press();
    const poll = async () => {
      try {
        if (await this.held(keys)) {
          if (this.pressed) this.timer = setTimeout(poll, 30);
        } else if (this.pressed) {
          this.pressed = false;
          this.release();
        }
      } catch (error) {
        if (!this.pressed) return;
        this.pressed = false;
        this.failure(error);
      }
    };
    this.timer = setTimeout(poll, 30);
  }
  close() {
    this.pressed = false;
    clearTimeout(this.timer);
  }
}

module.exports = { ShortcutBindings, ShortcutPress, shortcutKeys };
