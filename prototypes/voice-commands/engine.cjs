class VoiceCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceCommandError';
    this.code = code;
  }
}

function requireValue(condition, code, message) {
  if (!condition) throw new VoiceCommandError(code, message);
}

function identifier(value, name) {
  requireValue(typeof value === 'string' && value.trim().length > 0,
    'INVALID_INPUT', `${name} must be a nonempty string.`);
}

function commandIntentFromPhrase(phrase) {
  const commands = new Map([
    ['\u5f00\u59cb', 'start'],
    ['\u7ed3\u675f', 'finish'],
    ['\u53d1\u9001', 'send'],
  ]);
  requireValue(commands.has(phrase), 'UNRECOGNIZED_COMMAND', 'An exact command phrase is required.');
  return commands.get(phrase);
}

function createVoiceCommandEngine(options = {}) {
  requireValue(options !== null && typeof options === 'object' && !Array.isArray(options),
    'INVALID_INPUT', 'An options object is required.');
  const { sessionId } = options;
  identifier(sessionId, 'sessionId');
  let mode = 'idle';
  let consent = false;
  let activationId = null;
  let target = null;
  let latestTargetRevision = -1;
  let turnId = null;
  let turnSequence = 0;
  let requestSequence = 0;
  let pendingSend = null;
  const segments = new Map();
  const activations = new Set();
  const finalInputs = new Map();

  function text() {
    return [...segments.values()].filter((segment) => segment.phase === 'final')
      .map((segment) => segment.text).join('');
  }

  function snapshot() {
    return {
      sessionId, mode, consent, activationId, turnId,
      target: target ? { ...target } : null,
      text: text(),
      preview: [...segments.values()].map((segment) => segment.text).join(''),
      pendingSend: pendingSend ? { ...pendingSend } : null,
    };
  }

  function cancelPending(actions, reason) {
    if (!pendingSend) return;
    actions.push({ type: 'send-request-cancelled', ...pendingSend, reason });
    pendingSend = null;
    mode = 'ready';
  }

  function cancel(actions, reason) {
    cancelPending(actions, reason);
    if (mode === 'dictating' || mode === 'finishing') {
      actions.push({ type: 'cancel-dictation', sessionId, turnId, reason });
    }
    segments.clear();
    turnId = null;
    target = null;
    activationId = null;
    mode = 'idle';
  }

  function intentAction(intent, source, actions) {
    if (intent === 'start') {
      requireValue(['idle', 'ready', 'sent'].includes(mode),
        'INVALID_TRANSITION', 'Start requires idle, ready or sent mode.');
      segments.clear();
      turnId = `${sessionId}:turn-${++turnSequence}`;
      mode = 'dictating';
      actions.push({ type: 'start-dictation', sessionId, turnId, source });
    } else if (intent === 'finish') {
      requireValue(mode === 'dictating', 'INVALID_TRANSITION', 'Finish requires dictating mode.');
      mode = 'finishing';
      actions.push({ type: 'finish-dictation', sessionId, turnId, source });
    } else {
      requireValue(mode === 'ready', 'INVALID_TRANSITION', 'Send requires ready mode.');
      requireValue(text().trim().length > 0, 'EMPTY_DICTATION', 'Empty dictation cannot be sent.');
      requireValue(target !== null, 'TARGET_REQUIRED', 'Select a current target before requesting send.');
      pendingSend = {
        requestId: `${sessionId}:send-${++requestSequence}`,
        sessionId, turnId, ...target, text: text(), source,
      };
      mode = 'confirming';
      actions.push({ type: 'request-send-confirmation', ...pendingSend });
    }
  }

  function finalIntent(key, intent, source, actions) {
    if (finalInputs.has(key)) {
      requireValue(finalInputs.get(key) === intent, 'CONFLICTING_FINAL', 'A final input ID cannot change intent.');
      return 'DUPLICATE_FINAL';
    }
    // Consume well-formed finals even on rejection: a later mode must not revive an old command.
    finalInputs.set(key, intent);
    intentAction(intent, source, actions);
    return null;
  }

  function dispatch(event) {
    requireValue(event !== null && typeof event === 'object' && !Array.isArray(event),
      'INVALID_INPUT', 'An event object is required.');
    requireValue(typeof event.type === 'string', 'INVALID_INPUT', 'An event type is required.');
    if (mode === 'closed') {
      requireValue(event.type === 'close', 'CLOSED', 'The engine is closed.');
      return { status: 'ignored', reason: 'ALREADY_CLOSED', actions: [], snapshot: snapshot() };
    }
    const actions = [];
    let reason = null;
    switch (event.type) {
      case 'consent':
        requireValue(typeof event.enabled === 'boolean', 'INVALID_INPUT', 'Consent must be explicit boolean input.');
        if (event.enabled === consent) reason = 'UNCHANGED_CONSENT';
        else {
          if (!event.enabled) cancel(actions, 'consent-revoked');
          consent = event.enabled;
        }
        break;
      case 'activate':
        identifier(event.activationId, 'activationId');
        requireValue(consent, 'CONSENT_REQUIRED', 'Voice commands require explicit opt-in.');
        requireValue(activationId === null, 'ALREADY_ACTIVE', 'Deactivate the current command channel first.');
        requireValue(!activations.has(event.activationId), 'REPLAYED_ACTIVATION', 'Activation IDs are single use.');
        activations.add(event.activationId);
        activationId = event.activationId;
        break;
      case 'deactivate':
        identifier(event.activationId, 'activationId');
        requireValue(event.activationId === activationId, 'INACTIVE_ACTIVATION', 'The activation is not current.');
        cancelPending(actions, 'deactivated');
        activationId = null;
        break;
      case 'command':
        identifier(event.activationId, 'activationId');
        identifier(event.utteranceId, 'utteranceId');
        requireValue(['partial', 'final'].includes(event.phase), 'INVALID_INPUT', 'A command phase is required.');
        requireValue(['start', 'finish', 'send'].includes(event.intent), 'INVALID_INPUT', 'Unknown command intent.');
        requireValue(consent, 'CONSENT_REQUIRED', 'Voice commands require explicit opt-in.');
        requireValue(activationId !== null && event.activationId === activationId,
          'INACTIVE_ACTIVATION', 'Only the externally activated command channel may supply commands.');
        if (event.phase === 'partial') reason = 'PARTIAL_COMMAND';
        else reason = finalIntent(JSON.stringify(['command', activationId, event.utteranceId]),
          event.intent, 'command', actions);
        break;
      case 'manual':
        identifier(event.eventId, 'eventId');
        requireValue(['start', 'finish', 'send'].includes(event.intent), 'INVALID_INPUT', 'Unknown manual intent.');
        reason = finalIntent(JSON.stringify(['manual', event.eventId]), event.intent, 'manual', actions);
        break;
      case 'target':
        identifier(event.targetId, 'targetId');
        requireValue(Number.isSafeInteger(event.revision) && event.revision >= 0,
          'INVALID_INPUT', 'Target revision must be a nonnegative safe integer.');
        requireValue(event.revision >= latestTargetRevision, 'STALE_TARGET', 'Target revision is stale.');
        if (event.revision === latestTargetRevision) {
          requireValue(target !== null && target.targetId === event.targetId,
            'REVISION_REUSED', 'A changed or cleared target requires a newer revision.');
          reason = 'UNCHANGED_TARGET';
        } else {
          cancelPending(actions, 'target-changed');
          target = { targetId: event.targetId, revision: event.revision };
          latestTargetRevision = event.revision;
        }
        break;
      case 'dictation':
        identifier(event.turnId, 'turnId');
        identifier(event.segmentId, 'segmentId');
        requireValue(['partial', 'final'].includes(event.phase), 'INVALID_INPUT', 'A dictation phase is required.');
        requireValue(typeof event.text === 'string', 'INVALID_INPUT', 'Dictation text must be a string.');
        requireValue(event.turnId === turnId && ['dictating', 'finishing'].includes(mode),
          'INACTIVE_TURN', 'Dictation must belong to the current recording turn.');
        if (segments.get(event.segmentId)?.phase === 'final') {
          if (event.phase === 'final') {
            requireValue(segments.get(event.segmentId).text === event.text,
              'CONFLICTING_FINAL', 'A final segment cannot be rewritten.');
          }
          reason = 'FINAL_SEGMENT_ALREADY_RECEIVED';
        } else if (event.phase === 'partial' && mode === 'finishing') reason = 'FINALIZING_PARTIAL';
        else if (segments.get(event.segmentId)?.phase === event.phase &&
                 segments.get(event.segmentId).text === event.text) reason = 'DUPLICATE_PARTIAL';
        else segments.set(event.segmentId, { phase: event.phase, text: event.text });
        break;
      case 'dictation-finished':
        identifier(event.turnId, 'turnId');
        requireValue(event.turnId === turnId, 'INACTIVE_TURN', 'Completion must belong to the current recording turn.');
        if (['ready', 'confirming', 'sent'].includes(mode)) reason = 'DUPLICATE_COMPLETION';
        else {
          requireValue(mode === 'finishing', 'INVALID_TRANSITION', 'Completion requires a finish request.');
          for (const [id, segment] of segments) {
            if (segment.phase === 'partial') segments.delete(id);
          }
          mode = 'ready';
          actions.push({ type: 'dictation-ready', sessionId, turnId, text: text() });
        }
        break;
      case 'confirm-send':
        identifier(event.requestId, 'requestId');
        identifier(event.sessionId, 'sessionId');
        identifier(event.targetId, 'targetId');
        requireValue(Number.isSafeInteger(event.revision) && event.revision >= 0,
          'INVALID_INPUT', 'Confirmation revision must be a nonnegative safe integer.');
        requireValue(mode === 'confirming' && pendingSend !== null,
          'NO_PENDING_SEND', 'There is no current send confirmation.');
        requireValue(event.requestId === pendingSend.requestId, 'STALE_CONFIRMATION', 'Send request is stale.');
        requireValue(event.sessionId === sessionId, 'WRONG_SESSION', 'Confirmation belongs to another session.');
        requireValue(event.targetId === pendingSend.targetId, 'WRONG_TARGET', 'Confirmation target does not match.');
        requireValue(event.revision === pendingSend.revision && event.revision === target.revision,
          'STALE_CONFIRMATION', 'Confirmation revision is stale.');
        actions.push({ type: 'send', ...pendingSend });
        pendingSend = null;
        mode = 'sent';
        break;
      case 'cancel-send':
        identifier(event.requestId, 'requestId');
        requireValue(pendingSend !== null && event.requestId === pendingSend.requestId,
          'STALE_CONFIRMATION', 'Only the current send request may be cancelled.');
        cancelPending(actions, 'confirmation-cancelled');
        break;
      case 'cancel':
        cancel(actions, 'cancelled');
        break;
      case 'close':
        cancel(actions, 'closed');
        consent = false;
        activations.clear();
        finalInputs.clear();
        mode = 'closed';
        break;
      default:
        throw new VoiceCommandError('INVALID_INPUT', 'Unknown event type.');
    }
    return { status: reason ? 'ignored' : 'applied', reason, actions, snapshot: snapshot() };
  }

  return { dispatch, snapshot };
}

module.exports = { VoiceCommandError, commandIntentFromPhrase, createVoiceCommandEngine };
