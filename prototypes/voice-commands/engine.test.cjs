const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VoiceCommandError, commandIntentFromPhrase, createVoiceCommandEngine } = require('./engine.cjs');
const { runDemo } = require('./demo.cjs');

function create() {
  return createVoiceCommandEngine({ sessionId: 'test-session' });
}

function activate(engine, activationId = 'activation-1') {
  engine.dispatch({ type: 'consent', enabled: true });
  engine.dispatch({ type: 'activate', activationId });
}

function command(engine, intent, utteranceId = intent, phase = 'final', activationId = 'activation-1') {
  return engine.dispatch({ type: 'command', activationId, utteranceId, phase, intent });
}

function manual(engine, intent, eventId = intent) {
  return engine.dispatch({ type: 'manual', eventId, intent });
}

function dictation(engine, text, phase = 'final', segmentId = 'segment-1', turnId = engine.snapshot().turnId) {
  return engine.dispatch({ type: 'dictation', turnId, segmentId, phase, text });
}

function ready(engine, text = 'Synthetic text.') {
  manual(engine, 'start');
  dictation(engine, text);
  manual(engine, 'finish');
  return engine.dispatch({ type: 'dictation-finished', turnId: engine.snapshot().turnId });
}

function pending(engine) {
  ready(engine);
  engine.dispatch({ type: 'target', targetId: 'editor-1', revision: 1 });
  return manual(engine, 'send').snapshot.pendingSend;
}

function confirmation(request, overrides = {}) {
  const { requestId, sessionId, targetId, revision } = request;
  return { type: 'confirm-send', requestId, sessionId, targetId, revision, ...overrides };
}

function rejects(engine, event, code) {
  const before = engine.snapshot();
  assert.throws(() => engine.dispatch(event),
    (error) => error instanceof VoiceCommandError && error.code === code);
  assert.deepEqual(engine.snapshot(), before);
}

test('command phrase mapping is exact, explicit and not a transcript parser', () => {
  for (const [phrase, intent] of [
    ['\u5f00\u59cb', 'start'], ['\u7ed3\u675f', 'finish'], ['\u53d1\u9001', 'send'],
  ]) assert.equal(commandIntentFromPhrase(phrase), intent);
  for (const phrase of ['', 'start', '\u5f00\u59cb\u3002', ' \u5f00\u59cb',
    '\u4f1a\u8bae\u5f00\u59cb', null]) {
    assert.throws(() => commandIntentFromPhrase(phrase),
      (error) => error.code === 'UNRECOGNIZED_COMMAND');
  }
});

test('voice command consent and external activation are both required', () => {
  const engine = create();
  assert.deepEqual(engine.snapshot(), {
    sessionId: 'test-session', mode: 'idle', consent: false, activationId: null,
    turnId: null, target: null, text: '', preview: '', pendingSend: null,
  });
  rejects(engine, { type: 'activate', activationId: 'activation-1' }, 'CONSENT_REQUIRED');
  assert.throws(() => command(engine, 'start'), (error) => error.code === 'CONSENT_REQUIRED');
  assert.deepEqual(engine.dispatch({ type: 'consent', enabled: true }).actions, []);
  assert.throws(() => command(engine, 'start'), (error) => error.code === 'INACTIVE_ACTIVATION');
  assert.deepEqual(engine.dispatch({ type: 'activate', activationId: 'activation-1' }).actions, []);
  assert.throws(() => command(engine, 'start', 'start', 'final', 'wrong'), (error) => error.code === 'INACTIVE_ACTIVATION');
  const result = command(engine, 'start');
  assert.equal(result.snapshot.mode, 'dictating');
  assert.deepEqual(result.actions, [{
    type: 'start-dictation', sessionId: 'test-session', turnId: 'test-session:turn-1', source: 'command',
  }]);
});

test('partial and repeated command events never trigger transitions or double requests', () => {
  const engine = create();
  activate(engine);
  for (let index = 0; index < 3; index++) {
    const result = command(engine, 'start', 'utterance-1', 'partial');
    assert.equal(result.reason, 'PARTIAL_COMMAND');
    assert.equal(result.snapshot.mode, 'idle');
    assert.deepEqual(result.actions, []);
  }
  command(engine, 'start', 'utterance-1');
  const duplicate = command(engine, 'start', 'utterance-1');
  assert.equal(duplicate.reason, 'DUPLICATE_FINAL');
  assert.deepEqual(duplicate.actions, []);
  assert.equal(command(engine, 'send', 'utterance-1', 'partial').reason, 'PARTIAL_COMMAND');
  assert.throws(() => command(engine, 'finish', 'utterance-1'), (error) => error.code === 'CONFLICTING_FINAL');
});

test('well-formed rejected final intents cannot revive after the mode changes', () => {
  const engine = create();
  activate(engine);
  assert.throws(() => command(engine, 'send', 'early-send'), (error) => error.code === 'INVALID_TRANSITION');
  ready(engine);
  engine.dispatch({ type: 'target', targetId: 'editor-1', revision: 1 });
  const duplicate = command(engine, 'send', 'early-send');
  assert.equal(duplicate.reason, 'DUPLICATE_FINAL');
  assert.equal(duplicate.snapshot.mode, 'ready');
  assert.deepEqual(duplicate.actions, []);
  assert.throws(() => manual(engine, 'finish', 'early-finish'), (error) => error.code === 'INVALID_TRANSITION');
  engine.dispatch({ type: 'cancel' });
  manual(engine, 'start', 'next-start');
  assert.equal(manual(engine, 'finish', 'early-finish').reason, 'DUPLICATE_FINAL');
  assert.equal(engine.snapshot().mode, 'dictating');
});

test('ordinary dictated command words remain unchanged, even as standalone final segments', () => {
  const engine = create();
  activate(engine);
  command(engine, 'start');
  const words = ['\u5f00\u59cb', '\u7ed3\u675f', '\u53d1\u9001'];
  for (const [index, text] of words.entries()) {
    const result = dictation(engine, text, 'final', `segment-${index}`);
    assert.equal(result.snapshot.mode, 'dictating');
    assert.deepEqual(result.actions, []);
  }
  const sentence = '\uff1a\u4f1a\u8bae\u5f00\u59cb\u540e\u7ed3\u675f\u8ba8\u8bba\uff0c\u53d1\u9001\u7b14\u8bb0\u3002';
  dictation(engine, sentence, 'final', 'sentence');
  command(engine, 'finish');
  const result = engine.dispatch({ type: 'dictation-finished', turnId: engine.snapshot().turnId });
  assert.equal(result.snapshot.text, words.join('') + sentence);
  assert.equal(result.snapshot.mode, 'ready');
});

test('finish waits for final drain and cannot send preview or accept early completion', () => {
  const engine = create();
  activate(engine);
  const started = command(engine, 'start');
  const turnId = started.snapshot.turnId;
  dictation(engine, 'Preview only.', 'partial');
  rejects(engine, { type: 'dictation-finished', turnId }, 'INVALID_TRANSITION');
  const finishing = command(engine, 'finish');
  assert.equal(finishing.snapshot.mode, 'finishing');
  assert.equal(finishing.snapshot.text, '');
  assert.equal(finishing.actions[0].type, 'finish-dictation');
  assert.throws(() => command(engine, 'send'), (error) => error.code === 'INVALID_TRANSITION');
  assert.equal(dictation(engine, 'Late preview.', 'partial').reason, 'FINALIZING_PARTIAL');
  dictation(engine, 'Drained final.');
  dictation(engine, 'Drained final.');
  const result = engine.dispatch({ type: 'dictation-finished', turnId });
  assert.equal(result.snapshot.mode, 'ready');
  assert.equal(result.snapshot.text, 'Drained final.');
  assert.equal(result.actions[0].type, 'dictation-ready');
  assert.equal(engine.dispatch({ type: 'dictation-finished', turnId }).reason, 'DUPLICATE_COMPLETION');
  assert.throws(() => dictation(engine, 'Too late.'), (error) => error.code === 'INACTIVE_TURN');
});

test('dictation partials replace preview, finals are immutable and ordered by first appearance', () => {
  const engine = create();
  manual(engine, 'start');
  dictation(engine, 'A?', 'partial', 'a');
  assert.equal(dictation(engine, 'A?', 'partial', 'a').reason, 'DUPLICATE_PARTIAL');
  dictation(engine, 'B', 'final', 'b');
  assert.equal(engine.snapshot().text, 'B');
  dictation(engine, 'A', 'final', 'a');
  assert.equal(engine.snapshot().text, 'AB');
  assert.equal(dictation(engine, 'Changed preview', 'partial', 'a').reason, 'FINAL_SEGMENT_ALREADY_RECEIVED');
  assert.equal(dictation(engine, 'A', 'final', 'a').reason, 'FINAL_SEGMENT_ALREADY_RECEIVED');
  assert.throws(() => dictation(engine, 'Changed final', 'final', 'a'), (error) => error.code === 'CONFLICTING_FINAL');
  assert.equal(engine.snapshot().preview, 'AB');
});

test('unfinished previews are discarded on completion and empty/whitespace text cannot be sent', () => {
  for (const finalText of ['', ' \n\t']) {
    const engine = create();
    manual(engine, 'start');
    dictation(engine, 'Uncommitted words.', 'partial', 'preview');
    dictation(engine, finalText, 'final', 'final');
    manual(engine, 'finish');
    engine.dispatch({ type: 'dictation-finished', turnId: engine.snapshot().turnId });
    assert.equal(engine.snapshot().preview, finalText);
    engine.dispatch({ type: 'target', targetId: 'editor-1', revision: 1 });
    assert.throws(() => manual(engine, 'send'), (error) => error.code === 'EMPTY_DICTATION');
  }
});

test('manual/keyboard/PTT adapter intents work without voice consent or activation', () => {
  const engine = create();
  const request = pending(engine);
  assert.equal(engine.snapshot().consent, false);
  assert.equal(engine.snapshot().activationId, null);
  assert.equal(request.source, 'manual');
  assert.equal(manual(engine, 'send').reason, 'DUPLICATE_FINAL');
  const result = engine.dispatch(confirmation(request));
  assert.deepEqual(result.actions, [{ type: 'send', ...request }]);
  assert.equal(result.snapshot.mode, 'sent');
  assert.equal(result.snapshot.pendingSend, null);
  assert.equal(manual(engine, 'start', 'next-recording').snapshot.mode, 'dictating');
});

test('send requires a caller-supplied target and never supplies an OS or backend default', () => {
  const engine = create();
  ready(engine);
  assert.throws(() => manual(engine, 'send'), (error) => error.code === 'TARGET_REQUIRED');
  assert.equal(engine.snapshot().mode, 'ready');
  engine.dispatch({ type: 'target', targetId: 'editor-1', revision: 0 });
  assert.equal(manual(engine, 'send', 'new-send').actions[0].type, 'request-send-confirmation');
});

test('a send modal blocks fresh send/start/finish intents and emits nothing until explicit confirmation', () => {
  const engine = create();
  activate(engine);
  const request = pending(engine);
  for (const intent of ['start', 'finish', 'send']) {
    assert.throws(() => command(engine, intent, `modal-${intent}`),
      (error) => error.code === 'INVALID_TRANSITION');
    assert.equal(engine.snapshot().pendingSend.requestId, request.requestId);
  }
  assert.equal(engine.dispatch({ type: 'dictation-finished', turnId: request.turnId }).reason, 'DUPLICATE_COMPLETION');
  assert.equal(engine.dispatch(confirmation(request)).actions[0].type, 'send');
  rejects(engine, confirmation(request), 'NO_PENDING_SEND');
  assert.throws(() => command(engine, 'send', 'another-send'), (error) => error.code === 'INVALID_TRANSITION');
});

test('confirmation rejects incorrect request, session, target and revision without consuming the pending request', () => {
  const engine = create();
  const request = pending(engine);
  for (const [overrides, code] of [
    [{ requestId: 'old-send' }, 'STALE_CONFIRMATION'],
    [{ sessionId: 'different-session' }, 'WRONG_SESSION'],
    [{ targetId: 'different-editor' }, 'WRONG_TARGET'],
    [{ revision: 0 }, 'STALE_CONFIRMATION'],
    [{ revision: 2 }, 'STALE_CONFIRMATION'],
  ]) rejects(engine, confirmation(request, overrides), code);
  assert.equal(engine.dispatch(confirmation(request)).snapshot.mode, 'sent');
});

test('target changes invalidate pending sends; revisions are monotonic, including after cancellation', () => {
  const engine = create();
  const request = pending(engine);
  assert.equal(engine.dispatch({ type: 'target', targetId: 'editor-1', revision: 1 }).reason, 'UNCHANGED_TARGET');
  rejects(engine, { type: 'target', targetId: 'editor-2', revision: 1 }, 'REVISION_REUSED');
  rejects(engine, { type: 'target', targetId: 'editor-1', revision: 0 }, 'STALE_TARGET');
  const changed = engine.dispatch({ type: 'target', targetId: 'editor-2', revision: 2 });
  assert.equal(changed.snapshot.mode, 'ready');
  assert.equal(changed.actions[0].type, 'send-request-cancelled');
  assert.equal(changed.actions[0].reason, 'target-changed');
  rejects(engine, confirmation(request), 'NO_PENDING_SEND');
  const newRequest = manual(engine, 'send', 'send-new-target').snapshot.pendingSend;
  rejects(engine, confirmation(request), 'STALE_CONFIRMATION');
  assert.equal(newRequest.targetId, 'editor-2');
  assert.equal(newRequest.revision, 2);
  assert.notEqual(newRequest.requestId, request.requestId);
  engine.dispatch({ type: 'cancel' });
  rejects(engine, { type: 'target', targetId: 'editor-2', revision: 2 }, 'REVISION_REUSED');
  engine.dispatch({ type: 'target', targetId: 'editor-2', revision: 3 });
});

test('same-target editor revision changes also require a new send request', () => {
  const engine = create();
  const request = pending(engine);
  const result = engine.dispatch({ type: 'target', targetId: 'editor-1', revision: 2 });
  assert.equal(result.actions[0].reason, 'target-changed');
  const newRequest = manual(engine, 'send', 'send-revised-editor').snapshot.pendingSend;
  rejects(engine, confirmation(request), 'STALE_CONFIRMATION');
  rejects(engine, confirmation(newRequest, { revision: 1 }), 'STALE_CONFIRMATION');
  assert.equal(engine.dispatch(confirmation(newRequest)).actions[0].revision, 2);
});

test('cancelling a confirmation retains the draft, rejects old modal responses and permits a fresh request', () => {
  const engine = create();
  const request = pending(engine);
  rejects(engine, { type: 'cancel-send', requestId: 'wrong-request' }, 'STALE_CONFIRMATION');
  const cancelled = engine.dispatch({ type: 'cancel-send', requestId: request.requestId });
  assert.equal(cancelled.snapshot.mode, 'ready');
  assert.equal(cancelled.snapshot.text, request.text);
  assert.equal(cancelled.actions[0].reason, 'confirmation-cancelled');
  rejects(engine, confirmation(request), 'NO_PENDING_SEND');
  const next = manual(engine, 'send', 'retry-send').snapshot.pendingSend;
  rejects(engine, confirmation(request), 'STALE_CONFIRMATION');
  assert.equal(engine.dispatch(confirmation(next)).actions.length, 1);
});

test('cancel/consent revocation/close discard recording, activation, previews and target with explicit cleanup requests', () => {
  for (const type of ['cancel', 'consent', 'close']) {
    for (const initialMode of ['dictating', 'finishing']) {
      const engine = create();
      activate(engine);
      engine.dispatch({ type: 'target', targetId: 'editor-1', revision: 1 });
      command(engine, 'start');
      const oldTurn = engine.snapshot().turnId;
      dictation(engine, 'Final');
      dictation(engine, 'Preview', 'partial', 'preview');
      if (initialMode === 'finishing') command(engine, 'finish');
      const result = engine.dispatch(type === 'consent' ? { type, enabled: false } : { type });
      assert.deepEqual(result.actions, [{
        type: 'cancel-dictation', sessionId: 'test-session', turnId: oldTurn,
        reason: type === 'cancel' ? 'cancelled' : type === 'close' ? 'closed' : 'consent-revoked',
      }]);
      assert.equal(result.snapshot.mode, type === 'close' ? 'closed' : 'idle');
      assert.equal(result.snapshot.text, '');
      assert.equal(result.snapshot.preview, '');
      assert.equal(result.snapshot.turnId, null);
      assert.equal(result.snapshot.target, null);
      assert.equal(result.snapshot.activationId, null);
      assert.equal(result.snapshot.consent, type === 'cancel');
      rejects(engine, { type: 'dictation', turnId: oldTurn, segmentId: 'late', phase: 'final', text: 'Late' },
        type === 'close' ? 'CLOSED' : 'INACTIVE_TURN');
    }
  }
});

test('cancellation, revocation, deactivation and close all invalidate pending confirmations', () => {
  for (const event of [{ type: 'cancel' }, { type: 'consent', enabled: false },
    { type: 'deactivate', activationId: 'activation-1' }, { type: 'close' }]) {
    const engine = create();
    activate(engine);
    ready(engine);
    engine.dispatch({ type: 'target', targetId: 'editor-1', revision: 1 });
    const request = command(engine, 'send').snapshot.pendingSend;
    const result = engine.dispatch(event);
    assert.equal(result.actions[0].type, 'send-request-cancelled');
    assert.equal(result.snapshot.pendingSend, null);
    rejects(engine, confirmation(request), event.type === 'close' ? 'CLOSED' : 'NO_PENDING_SEND');
    if (event.type === 'deactivate') assert.equal(result.snapshot.text, request.text);
  }
});

test('deactivation preserves manual dictation while old/reused activation and cancelled turn IDs are rejected', () => {
  const engine = create();
  activate(engine);
  command(engine, 'start');
  const firstTurn = engine.snapshot().turnId;
  engine.dispatch({ type: 'deactivate', activationId: 'activation-1' });
  assert.equal(engine.snapshot().mode, 'dictating');
  assert.throws(() => command(engine, 'finish'), (error) => error.code === 'INACTIVE_ACTIVATION');
  rejects(engine, { type: 'activate', activationId: 'activation-1' }, 'REPLAYED_ACTIVATION');
  engine.dispatch({ type: 'activate', activationId: 'activation-2' });
  engine.dispatch({ type: 'cancel' });
  manual(engine, 'start', 'start-next-turn');
  assert.notEqual(engine.snapshot().turnId, firstTurn);
  assert.throws(() => dictation(engine, 'Old', 'final', 'segment-1', firstTurn), (error) => error.code === 'INACTIVE_TURN');
  rejects(engine, { type: 'dictation-finished', turnId: firstTurn }, 'INACTIVE_TURN');
});

test('close is terminal and idempotent, without retaining drafts or emitting cleanup twice', () => {
  const engine = create();
  manual(engine, 'start');
  assert.equal(engine.dispatch({ type: 'close' }).actions.length, 1);
  assert.equal(engine.dispatch({ type: 'close' }).reason, 'ALREADY_CLOSED');
  assert.deepEqual(engine.dispatch({ type: 'close' }).actions, []);
  rejects(engine, { type: 'consent', enabled: true }, 'CLOSED');
  rejects(engine, { type: 'manual', eventId: 'late-start', intent: 'start' }, 'CLOSED');
});

test('returned snapshots and action objects cannot mutate engine state or its confirmation binding', () => {
  const engine = create();
  const request = pending(engine);
  request.targetId = 'mutated-editor';
  const snapshot = engine.snapshot();
  snapshot.target.revision = 999;
  snapshot.pendingSend.text = 'Mutated text';
  assert.equal(engine.snapshot().target.revision, 1);
  assert.equal(engine.snapshot().pendingSend.text, 'Synthetic text.');
  rejects(engine, confirmation(request), 'WRONG_TARGET');
  const action = engine.dispatch(confirmation(engine.snapshot().pendingSend)).actions[0];
  action.text = 'Mutated delivery';
  assert.equal(engine.snapshot().text, 'Synthetic text.');
});

test('malformed options/events produce explicit validation errors rather than defaults', () => {
  for (const options of [undefined, null, [], { sessionId: '' }, { sessionId: 1 }]) {
    assert.throws(() => createVoiceCommandEngine(options), (error) => error.code === 'INVALID_INPUT');
  }
  const engine = create();
  for (const event of [null, [], {}, { type: 'unknown' }, { type: 'consent', enabled: 'yes' },
    { type: 'activate', activationId: '' }, { type: 'manual', eventId: 'x', intent: 'confirm' },
    { type: 'command', activationId: 'a', utteranceId: 'u', intent: 'start' },
    { type: 'dictation', turnId: 't', segmentId: 's', phase: 'final', text: 1 },
    { type: 'target', targetId: '', revision: 1 }, { type: 'target', targetId: 'e', revision: -1 },
    { type: 'target', targetId: 'e', revision: 0.5 },
    { type: 'target', targetId: 'e', revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    rejects(engine, event, 'INVALID_INPUT');
  }
});

test('synthetic demo is deterministic, preserves ordinary words and requests exactly one confirmed send action', () => {
  const trace = runDemo();
  assert.deepEqual(runDemo(), trace);
  const actions = trace.flatMap((step) => step.actions);
  assert.equal(actions.filter((action) => action.type === 'start-dictation').length, 1);
  assert.equal(actions.filter((action) => action.type === 'finish-dictation').length, 1);
  assert.equal(actions.filter((action) => action.type === 'request-send-confirmation').length, 1);
  assert.equal(actions.filter((action) => action.type === 'send').length, 1);
  assert.equal(trace.at(-1).snapshot.mode, 'closed');
  const send = actions.find((action) => action.type === 'send');
  for (const word of ['\u5f00\u59cb', '\u7ed3\u675f', '\u53d1\u9001']) assert.ok(send.text.includes(word));
});
