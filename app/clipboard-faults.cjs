const stages = new Set(['unspecified', 'restore-open', 'restore-sequence', 'restore-copy', 'restore-empty', 'restore-write',
  'publication-open', 'publication-close', 'publication-owner', 'publication-sequence', 'publication-state', 'publication-write']);
const codes = new Set(['native-error', 'window-order', 'target-changed', 'secure-field', 'no-input', 'clipboard-changed',
  'clipboard-unavailable', 'clipboard-busy', 'clipboard-format', 'clipboard-snapshot-failed', 'modifiers-held',
  'composition-active', 'paste-unconfirmed', 'restore-failed']);

function clipboardCauses(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) return undefined;
  const result = [];
  for (const cause of value) {
    if (!cause || typeof cause !== 'object' || Array.isArray(cause) ||
        !codes.has(cause.code) || !stages.has(cause.stage) ||
        !Number.isInteger(cause.format) || cause.format < 0 || cause.format > 65535 ||
        !Number.isInteger(cause.errorNumber) || cause.errorNumber < 0 || cause.errorNumber > 2147483647) return undefined;
    result.push({ code: cause.code, stage: cause.stage, format: cause.format, errorNumber: cause.errorNumber });
  }
  return result;
}

module.exports = { clipboardCauses };
