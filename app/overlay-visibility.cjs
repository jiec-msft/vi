function overlayWindowOptions(platform) {
  return { width: 224, height: 54, frame: false, focusable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false, resizable: false, movable: true, acceptFirstMouse: true,
    transparent: platform !== 'win32', backgroundColor: platform === 'win32' ? '#111827' : '#00000000' };
}

class OverlayVisibility {
  constructor(window, displays, observe) {
    this.window = window;
    this.displays = displays;
    this.observe = observe;
    this.wanted = false;
    this.userHidden = false;
    this.reloads = 0;
  }
  allow() { this.userHidden = false; }
  hideByUser() {
    this.userHidden = true;
    this.window.hide();
    this.record('hidden');
  }
  record(state) {
    if (this.window.isDestroyed()) return;
    const bounds = this.window.getBounds();
    this.observe({ state, overlayX: bounds.x, overlayY: bounds.y,
      overlayWidth: bounds.width, overlayHeight: bounds.height,
      overlayVisible: this.window.isVisible(), overlayExpected: this.wanted,
      overlayUserHidden: this.userHidden, overlayTopmost: this.window.isAlwaysOnTop() });
  }
  layout() {
    const bounds = this.window.getBounds();
    const displays = this.displays();
    if (!displays.length) throw new Error('Floating window display information is unavailable.');
    const overlap = (area) => Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x)) * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y));
    const areas = displays.map((display) => display.workArea);
    const area = areas.reduce((best, current) => overlap(current) > overlap(best) ? current : best, areas[0]);
    const next = { width: 224, height: 54,
      x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - 224)))),
      y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + Math.max(0, area.height - 54)))) };
    if (Object.keys(next).some((key) => bounds[key] !== next[key])) {
      this.window.setBounds(next, false);
      this.record('bounds');
    }
  }
  update(wanted, binding = false) {
    if (this.window.isDestroyed()) return;
    const changed = this.wanted !== wanted;
    this.wanted = wanted;
    this.binding = binding;
    if (!wanted || this.userHidden) {
      if (this.window.isVisible()) this.window.hide();
      return;
    }
    if (binding || this.window.isDestroyed()) return;
    if (changed || !this.window.isVisible()) this.layout();
    if (!this.window.isAlwaysOnTop()) this.window.setAlwaysOnTop(true);
    if (!this.window.isVisible()) this.window.showInactive();
  }
  displayChanged() { this.layout(); this.update(this.wanted, this.binding); this.record('display'); }
  rendererGone() {
    this.record('process-gone');
    if (this.reloads++ >= 1) throw new Error('Floating controls stopped repeatedly. Restart VI; the approved result remains in preview.');
    this.window.webContents.reload();
  }
  rendererReady() { this.update(this.wanted, this.binding); this.record('ready'); }
}

module.exports = { OverlayVisibility, overlayWindowOptions };
