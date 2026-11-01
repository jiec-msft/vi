const assert = require('node:assert/strict');
const { commandIntentFromPhrase, createVoiceCommandEngine } = require('./engine.cjs');

function runDemo() {
  const engine = createVoiceCommandEngine({ sessionId: 'synthetic-session' });
  const trace = [];
  function apply(event) {
    const result = engine.dispatch(event);
    trace.push({ event, ...result });
    return result;
  }
  function command(utteranceId, phrase, phase = 'final') {
    return apply({
      type: 'command', activationId: 'synthetic-activation', utteranceId,
      phase, intent: commandIntentFromPhrase(phrase),
    });
  }

  apply({ type: 'consent', enabled: true });
  apply({ type: 'activate', activationId: 'synthetic-activation' });
  apply({ type: 'target', targetId: 'synthetic-editor', revision: 1 });
  command('start-1', '\u5f00\u59cb', 'partial');
  const started = command('start-1', '\u5f00\u59cb');
  const turnId = started.snapshot.turnId;
  command('start-1', '\u5f00\u59cb');
  const text = '\u4f1a\u8bae\u5f00\u59cb\u540e\u8ba8\u8bba\u7ed3\u675f\u65f6\u95f4\uff0c\u518d\u53d1\u9001\u8bb0\u5f55\u3002';
  apply({ type: 'dictation', turnId, segmentId: 'segment-1', phase: 'partial', text });
  command('finish-1', '\u7ed3\u675f');
  apply({ type: 'dictation', turnId, segmentId: 'segment-1', phase: 'final', text });
  apply({ type: 'dictation', turnId, segmentId: 'segment-1', phase: 'final', text });
  apply({ type: 'dictation-finished', turnId });
  const requested = command('send-1', '\u53d1\u9001');
  assert.equal(requested.actions[0].type, 'request-send-confirmation');
  assert.equal(requested.snapshot.text, text);
  assert.equal(trace.flatMap((step) => step.actions).filter((action) => action.type === 'send').length, 0);
  command('send-1', '\u53d1\u9001');
  const { requestId, sessionId, targetId, revision } = requested.snapshot.pendingSend;
  const confirmed = apply({ type: 'confirm-send', requestId, sessionId, targetId, revision });
  assert.equal(confirmed.actions.length, 1);
  assert.equal(confirmed.actions[0].type, 'send');
  assert.equal(confirmed.actions[0].text, text);
  apply({ type: 'close' });
  return trace;
}

if (require.main === module) {
  console.log(JSON.stringify({ kind: 'synthetic-event-demo', trace: runDemo() }, null, 2));
}

module.exports = { runDemo };
