'use strict';

const MAX_SAMPLE_AGE_MS = 250;
const WINDOW_POLICY = Object.freeze({
  activate: false,
  focusable: false,
  pointer: 'passthrough',
  accessibility: 'status-only',
  targetText: 'unchanged',
  finalDelivery: 'unchanged',
});

function hidden(reason) {
  return { action: 'hide', reason, windowPolicy: WINDOW_POLICY };
}

function validRect(rect, caret = false) {
  return rect !== null && typeof rect === 'object' &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) &&
    (caret ? rect.width >= 0 : rect.width > 0) && rect.height > 0 &&
    Number.isFinite(rect.x + rect.width) && Number.isFinite(rect.y + rect.height);
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

function fresh(observedAt, now) {
  return Number.isFinite(now) && Number.isFinite(observedAt) &&
    observedAt >= 0 && now >= observedAt && now - observedAt <= MAX_SAMPLE_AGE_MS;
}

function validMonitor(monitor) {
  return monitor && typeof monitor.id === 'string' && monitor.id.length > 0 &&
    validRect(monitor.bounds) && validRect(monitor.workArea) &&
    contains(monitor.bounds, monitor.workArea) &&
    Number.isFinite(monitor.scale) && monitor.scale > 0;
}

function physicalRect(rect) {
  if (!validRect(rect, true) || rect.space !== 'screen-physical') {
    return { status: 'blocked', reason: 'physical-geometry-required' };
  }
  return { status: 'available', rect: {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
  } };
}

function uiaCaretRect(values, active) {
  if (active !== true) return { status: 'blocked', reason: 'inactive-caret' };
  if (!Array.isArray(values) || values.length !== 4) {
    return { status: 'blocked', reason: 'missing-or-ambiguous-caret' };
  }
  const [x, y, width, height] = values;
  return physicalRect({ x, y, width, height, space: 'screen-physical' });
}

function axCaretRect(rect, display) {
  if (!validRect(rect, true) || rect.space !== 'ax-screen-points' ||
      !display || !validRect(display.axBounds) || !validRect(display.pixelBounds) ||
      !Number.isFinite(display.scale) || display.scale <= 0 ||
      display.axBounds.width * display.scale !== display.pixelBounds.width ||
      display.axBounds.height * display.scale !== display.pixelBounds.height ||
      !contains(display.axBounds, rect)) {
    return { status: 'blocked', reason: 'unverified-display-transform' };
  }
  return physicalRect({
    x: display.pixelBounds.x + (rect.x - display.axBounds.x) * display.scale,
    y: display.pixelBounds.y + (rect.y - display.axBounds.y) * display.scale,
    width: rect.width * display.scale,
    height: rect.height * display.scale,
    space: 'screen-physical',
  });
}

function markerPlacement(caret, monitor) {
  const width = Math.ceil(24 * monitor.scale);
  const height = Math.ceil(28 * monitor.scale);
  const gap = Math.ceil(6 * monitor.scale);
  const center = caret.x + caret.width / 2;
  const candidates = [
    { x: center - width / 2, y: caret.y + caret.height + gap },
    { x: center - width / 2, y: caret.y - gap - height },
    { x: caret.x + caret.width + gap, y: caret.y },
    { x: caret.x - gap - width, y: caret.y },
  ];
  for (const position of candidates) {
    const rect = { x: Math.floor(position.x), y: Math.floor(position.y), width, height };
    if (contains(monitor.workArea, rect) && !overlaps(rect, caret)) return rect;
  }
  return null;
}

function planCaret(sample, context) {
  if (!context || context.recording !== true) return hidden('not-recording');
  if (!sample) return hidden('missing-target');
  if (typeof sample.targetKey !== 'string' || !sample.targetKey ||
      sample.targetKey !== context.targetKey) return hidden('target-changed');
  if (sample.focusRevision !== context.focusRevision ||
      !Number.isSafeInteger(sample.focusRevision) || sample.focusRevision < 0) {
    return hidden('focus-changed');
  }
  if (sample.permission !== 'granted') return hidden('permission-unavailable');
  if (sample.fieldSecurity !== 'plain') return hidden('secure-or-unknown-field');
  if (sample.integrity !== 'same') return hidden('integrity-unavailable');
  if (sample.delivery !== 'eligible') return hidden('delivery-blocked');
  if (sample.active !== true || sample.visible !== true) return hidden('inactive-target');
  if (sample.capability !== 'available') return hidden('caret-unavailable');
  if (!fresh(sample.observedAt, context.now)) return hidden('stale-target');
  if (!Number.isSafeInteger(sample.topologyRevision) || sample.topologyRevision < 0 ||
      sample.topologyRevision !== context.topologyRevision) return hidden('topology-changed');
  if (!Array.isArray(context.monitors)) return hidden('monitor-unavailable');
  const matches = context.monitors.filter((monitor) => monitor.id === sample.monitorId);
  if (matches.length !== 1 || !validMonitor(matches[0])) return hidden('monitor-unavailable');
  const monitor = matches[0];
  const geometry = physicalRect(sample.rect);
  if (geometry.status !== 'available') return hidden(geometry.reason);
  if (!contains(monitor.workArea, geometry.rect)) return hidden('caret-outside-work-area');
  const rect = markerPlacement(geometry.rect, monitor);
  if (!rect) return hidden('no-adjacent-space');
  return {
    action: 'show', presentation: 'caret-marker', rect, space: 'screen-physical',
    appearance: { color: '#0078d4', symbol: 'microphone', animation: 'none' },
    windowPolicy: WINDOW_POLICY,
  };
}

class CaretPresentation {
  #generation = 0;
  #request = 0;
  #targetKey = null;
  #sample = null;
  #reason = 'not-recording';
  #disposed = false;
  #lastNow = -1;

  begin(targetKey) {
    if (this.#disposed) throw new Error('Presentation is disposed.');
    if (typeof targetKey !== 'string' || !targetKey) throw new TypeError('Target key is required.');
    this.#generation++;
    this.#targetKey = targetKey;
    this.#sample = null;
    this.#lastNow = -1;
    this.#reason = 'missing-target';
  }

  request() {
    if (this.#disposed || this.#targetKey === null) return { status: 'blocked', reason: this.#reason };
    return { status: 'pending', generation: this.#generation, sequence: ++this.#request };
  }

  accept(ticket, sample) {
    if (this.#disposed || this.#targetKey === null || !ticket ||
        ticket.status !== 'pending' || ticket.generation !== this.#generation ||
        ticket.sequence !== this.#request) {
      return { status: 'blocked', reason: 'obsolete-query' };
    }
    // A result is consumed once; a duplicate completion cannot refresh old geometry.
    this.#request++;
    if (!sample || sample.targetKey !== this.#targetKey) {
      this.#sample = null;
      this.#reason = 'target-changed';
      return { status: 'blocked', reason: this.#reason };
    }
    this.#sample = structuredClone(sample);
    return { status: 'accepted' };
  }

  invalidate(reason) {
    if (typeof reason !== 'string' || !reason) throw new TypeError('Invalidation reason is required.');
    this.#generation++;
    this.#sample = null;
    this.#reason = reason;
    return hidden(reason);
  }

  plan(context) {
    if (this.#disposed || this.#targetKey === null || !this.#sample) return hidden(this.#reason);
    if (!context || context.targetKey !== this.#targetKey) return this.invalidate('target-changed');
    if (!Number.isFinite(context.now) || context.now < this.#lastNow) return this.invalidate('clock-invalid');
    this.#lastNow = context.now;
    const plan = planCaret(this.#sample, context);
    if (plan.action === 'hide') this.invalidate(plan.reason);
    return plan;
  }

  stop() {
    this.#targetKey = null;
    return this.invalidate('not-recording');
  }

  dispose() {
    this.stop();
    this.#disposed = true;
    this.#reason = 'disposed';
    return hidden('disposed');
  }
}

function planDock(input) {
  if (!input || !['floating', 'native-taskbar', 'docked-window'].includes(input.mode)) {
    return hidden('unknown-presentation-mode');
  }
  if (input.mode === 'floating') return { action: 'unchanged', presentation: 'floating' };
  if (input.mode === 'native-taskbar') return hidden('native-taskbar-slot-unsupported');
  if (input.capability !== 'available') return hidden('nonactivating-window-unavailable');
  const snapshot = input.snapshot;
  if (!snapshot || !fresh(snapshot.observedAt, input.now)) return hidden('stale-shell-state');
  if (!Number.isSafeInteger(snapshot.topologyRevision) || snapshot.topologyRevision < 0 ||
      snapshot.topologyRevision !== input.topologyRevision) return hidden('topology-changed');
  if (snapshot.fullscreen !== false) return hidden('fullscreen-or-unknown');
  if (snapshot.autoHide !== 'disabled') return hidden('autohide-or-unknown');
  if (snapshot.space !== 'screen-physical') return hidden('physical-geometry-required');
  if (!validMonitor(input.monitor) || snapshot.monitorId !== input.monitor.id) {
    return hidden('monitor-unavailable');
  }
  if (!['bottom', 'top', 'left', 'right'].includes(snapshot.edge)) return hidden('unknown-taskbar-edge');
  if (!validRect(snapshot.taskbar) || !contains(input.monitor.bounds, snapshot.taskbar)) {
    return hidden('taskbar-geometry-unavailable');
  }
  const bounds = input.monitor.bounds;
  const taskbar = snapshot.taskbar;
  const touchesEdge = {
    bottom: taskbar.y + taskbar.height === bounds.y + bounds.height,
    top: taskbar.y === bounds.y,
    left: taskbar.x === bounds.x,
    right: taskbar.x + taskbar.width === bounds.x + bounds.width,
  };
  if (!touchesEdge[snapshot.edge] || overlaps(input.monitor.workArea, taskbar)) {
    return hidden('inconsistent-shell-geometry');
  }
  if (!input.sizeDip || !Number.isFinite(input.sizeDip.width) || input.sizeDip.width < 44 ||
      !Number.isFinite(input.sizeDip.height) || input.sizeDip.height < 44) {
    return hidden('invalid-accessible-size');
  }
  const width = Math.ceil(input.sizeDip.width * input.monitor.scale);
  const height = Math.ceil(input.sizeDip.height * input.monitor.scale);
  const gap = Math.ceil(8 * input.monitor.scale);
  const work = input.monitor.workArea;
  const rect = {
    x: snapshot.edge === 'left' ? work.x + gap : work.x + work.width - gap - width,
    y: snapshot.edge === 'top' ? work.y + gap : work.y + work.height - gap - height,
    width, height,
  };
  if (!validRect(rect) || !contains(work, rect)) return hidden('no-docking-space');
  return {
    action: 'show', presentation: 'docked-window',
    label: 'Docked window (not taskbar embedded)',
    anchor: 'work-area-corner', rect, space: 'screen-physical',
    windowPolicy: WINDOW_POLICY,
  };
}

module.exports = {
  MAX_SAMPLE_AGE_MS, WINDOW_POLICY, physicalRect, uiaCaretRect, axCaretRect,
  planCaret, CaretPresentation, planDock, markerPlacement,
};
