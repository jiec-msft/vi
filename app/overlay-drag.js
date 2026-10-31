class OverlayDrag {
  constructor({ window, cursor, workArea, persist }) {
    this.window = window;
    this.cursor = cursor;
    this.workArea = workArea;
    this.persist = persist;
  }

  get active() { return Boolean(this.anchor); }

  start() {
    if (this.active || this.window.isDestroyed() || !this.window.isVisible()) return false;
    this.anchor = { cursor: this.cursor(), bounds: this.window.getBounds() };
    return true;
  }

  move() {
    if (!this.active) return false;
    if (this.window.isDestroyed() || !this.window.isVisible()) { this.cancel(); return false; }
    try {
      return this.moveToCursor();
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  moveToCursor() {
    const point = this.cursor();
    const area = this.workArea(point);
    const { bounds, cursor } = this.anchor;
    const x = Math.round(Math.max(area.x, Math.min(
      area.x + Math.max(0, area.width - bounds.width), bounds.x + point.x - cursor.x)));
    const y = Math.round(Math.max(area.y, Math.min(
      area.y + Math.max(0, area.height - bounds.height), bounds.y + point.y - cursor.y)));
    const current = this.window.getBounds();
    if (x !== current.x || y !== current.y) this.window.setPosition(x, y, false);
    return true;
  }

  async finish() {
    if (!this.active) return;
    this.move();
    if (!this.active) return;
    this.anchor = undefined;
    if (this.window.isDestroyed()) return;
    const { x, y } = this.window.getBounds();
    await this.persist({ x, y });
  }

  cancel() { this.anchor = undefined; }
}

function bindDragHandle(handle, bridge, onFailure, view = globalThis, enabled = () => true) {
  let pointer;
  let frame;
  let hovered = false;
  let gesture = 0;
  const dispatch = (action) => {
    const current = gesture;
    void bridge.drag(action).then((reply) => {
      if (!reply.ok) throw new Error(reply.error);
      if (current === gesture && action === 'start' && reply.value === false) cancel();
    }).catch((error) => {
      if (current === gesture) cancel();
      onFailure(error);
    });
  };
  const release = (action) => {
    if (pointer === undefined) return;
    const previous = pointer;
    pointer = undefined;
    gesture++;
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    handle.classList.remove('dragging');
    if (handle.hasPointerCapture(previous)) handle.releasePointerCapture(previous);
    hovered = false;
    dispatch(action);
  };
  const cancel = () => release('cancel');
  const finish = (event) => {
    if (event.pointerId === pointer) release('end');
  };
  const start = (event) => {
    if (!enabled() || event.pointerType !== 'mouse' || pointer !== undefined) return;
    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); }
    catch {
      onFailure(new Error('Could not capture the mouse for floating-window movement.'));
      return;
    }
    pointer = event.pointerId;
    gesture++;
    handle.classList.add('dragging');
    dispatch('start');
  };
  handle.addEventListener('pointerdown', (event) => {
    if (event.button === 0) start(event);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!enabled()) { cancel(); return; }
    // Windows can eat the first mouse-down on a non-activating window.
    if (pointer === undefined && event.pointerType === 'mouse') {
      if (event.buttons === 0) hovered = true;
      else if ((event.buttons & 1) && hovered) start(event);
    }
    if (event.pointerId !== pointer) return;
    if (!(event.buttons & 1)) { finish(event); return; }
    if (frame !== undefined) return;
    frame = view.requestAnimationFrame(() => { frame = undefined; dispatch('move'); });
  });
  handle.addEventListener('pointerleave', () => { if (pointer === undefined) hovered = false; });
  handle.addEventListener('pointerup', finish);
  for (const name of ['pointercancel', 'lostpointercapture']) {
    handle.addEventListener(name, (event) => { if (event.pointerId === pointer) cancel(); });
  }
  return { cancel };
}

if (typeof module !== 'undefined') module.exports = { OverlayDrag, bindDragHandle };
