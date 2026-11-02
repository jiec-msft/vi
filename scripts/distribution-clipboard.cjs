const assert = require('node:assert/strict');

function createMixedClipboardItem(ClipboardItem) {
  return new ClipboardItem({ 'text/plain': 'Owned original clipboard',
    'text/html': '<b>Owned original rich clipboard</b>' });
}

async function writeMixedClipboard(clipboard, ClipboardItem) {
  await clipboard.write([createMixedClipboardItem(ClipboardItem)]);
}

async function readMixedClipboard(clipboard) {
  const items = await clipboard.read();
  assert.ok(Array.isArray(items) && items.length === 1, 'Expected one owned mixed clipboard entry.');
  const item = items[0];
  assert.ok(item && Array.isArray(item.types) && typeof item.getType === 'function',
    'Clipboard entry must expose its MIME types and getType method.');
  assert.ok(['text/plain', 'text/html'].every((mime) => item.types.includes(mime)),
    'Owned clipboard is missing a required representation.');
  const result = {};
  for (const [mime, name] of [['text/plain', 'text'], ['text/html', 'html']]) {
    const blob = await item.getType(mime);
    assert.ok(blob instanceof Blob, 'Clipboard representation must be a Blob.');
    result[name] = Buffer.from(await blob.arrayBuffer());
  }
  return result;
}

module.exports = { createMixedClipboardItem, writeMixedClipboard, readMixedClipboard };
