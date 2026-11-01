'use strict';

const { CaretPresentation, planDock } = require('./presentation.cjs');

const monitor = {
  id: 'synthetic-monitor', scale: 1.5,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1020 },
};
const context = {
  now: 1000, recording: true, targetKey: 'synthetic-target',
  focusRevision: 1, topologyRevision: 1, monitors: [monitor],
};
const sample = {
  ...context, observedAt: 1000, monitorId: monitor.id,
  permission: 'granted', fieldSecurity: 'plain', integrity: 'same', delivery: 'eligible',
  active: true, visible: true, capability: 'available',
  rect: { x: -600, y: 200, width: 0, height: 24, space: 'screen-physical' },
};
const session = new CaretPresentation();
session.begin(context.targetKey);
session.accept(session.request(), sample);
const recording = session.plan(context);
const focusChanged = session.plan({ ...context, targetKey: 'synthetic-other-field' });
const lateCompletion = session.accept(session.request(), { ...sample, targetKey: 'synthetic-other-field' });
const dock = {
  mode: 'docked-window', capability: 'available', now: 1000, topologyRevision: 1,
  monitor, sizeDip: { width: 88, height: 44 },
  snapshot: {
    observedAt: 1000, topologyRevision: 1, monitorId: monitor.id, fullscreen: false,
    autoHide: 'disabled', edge: 'bottom', space: 'screen-physical',
    taskbar: { x: -1920, y: 1020, width: 1920, height: 60 },
  },
};
console.log(JSON.stringify({
  schemaVersion: 1, evidenceKind: 'synthetic-policy-demo', nativeUiExercised: false,
  recording, focusChanged, lateCompletion,
  dockedAlternative: planDock(dock),
  nativeTaskbar: planDock({ ...dock, mode: 'native-taskbar' }),
  autoHide: planDock({ ...dock, snapshot: { ...dock.snapshot, autoHide: 'revealed' } }),
  cleanup: session.dispose(),
}, null, 2));
