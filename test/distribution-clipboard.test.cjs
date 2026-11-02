const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMixedClipboardItem, writeMixedClipboard, readMixedClipboard } = require('../scripts/distribution-clipboard.cjs');

class StrictClipboardItem {
  constructor(payloads) {
    assert.deepEqual(Object.keys(payloads).sort(), ['text/html', 'text/plain']);
    this.payloads = payloads;
    this.types = Object.keys(payloads);
    this.reads = [];
  }
  async getType(mime) {
    this.reads.push(mime);
    assert.ok(this.types.includes(mime));
    const value = this.payloads[mime];
    return value instanceof Blob ? value : new Blob([value], { type: mime });
  }
}

function fixture() {
  let items = [];
  const writes = [];
  return { writes, setItems: (value) => { items = value; }, clipboard: {
    async write(value) {
      if (!Array.isArray(value) || value.length !== 1 || !(value[0] instanceof StrictClipboardItem)) {
        throw new TypeError('Clipboard.write requires ClipboardItem[].');
      }
      writes.push(value);
      items = value;
    },
    async read() { return items; },
    readText() { throw new Error('Mixed clipboard cannot substitute plain-only readText.'); },
    writeText() { throw new Error('Mixed clipboard cannot use separate plain-text writes.'); },
  } };
}

test('legacy dictionary and untyped array shapes are rejected before any clipboard commit', async () => {
  const f = fixture();
  const legacy = { text: 'Owned original clipboard', html: '<b>Owned original rich clipboard</b>' };
  await assert.rejects(f.clipboard.write(legacy), TypeError);
  await assert.rejects(f.clipboard.write([legacy]), TypeError);
  assert.equal(f.writes.length, 0);
  assert.equal(f.clipboard.readHTML, undefined);
  await writeMixedClipboard(f.clipboard, StrictClipboardItem);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].length, 1);
  assert.deepEqual(f.writes[0][0].types, ['text/plain', 'text/html']);
  const actual = await readMixedClipboard(f.clipboard);
  assert.equal(actual.text.toString('utf8'), legacy.text);
  assert.equal(actual.html.toString('utf8'), legacy.html);
  assert.deepEqual(f.writes[0][0].reads, ['text/plain', 'text/html']);
});

test('mixed snapshots require both MIME representations on the same single entry', async () => {
  const f = fixture(), item = createMixedClipboardItem(StrictClipboardItem);
  for (const invalid of [[], [item, item], { text: 'legacy' },
    [{ types: ['text/plain'], getType: () => assert.fail('Missing HTML must fail before reading payloads.') }]]) {
    f.setItems(invalid);
    await assert.rejects(readMixedClipboard(f.clipboard), /one owned mixed|missing a required representation/);
  }
  f.setItems([{ types: ['text/plain', 'text/html'], getType: async () => 'not a Blob' }]);
  await assert.rejects(readMixedClipboard(f.clipboard), /must be a Blob/);
});

test('required MIME read failures and atomic write failures reject without fallback', async () => {
  const writeError = new Error('Owned atomic write failed.');
  await assert.rejects(writeMixedClipboard({ write: async () => { throw writeError; } }, StrictClipboardItem),
    (error) => error === writeError);
  const readError = new Error('Owned MIME read failed.');
  const f = fixture();
  f.setItems([{ types: ['text/plain', 'text/html'], getType: async () => { throw readError; } }]);
  await assert.rejects(readMixedClipboard(f.clipboard), (error) => error === readError);
});

test('mixed write remains pending until the single atomic ClipboardItem commit resolves', async () => {
  let commit, finished = false, writes = 0;
  const clipboard = { write(items) {
    writes++;
    assert.ok(Array.isArray(items) && items.length === 1 && items[0] instanceof StrictClipboardItem);
    return new Promise((resolve) => { commit = resolve; });
  } };
  const pending = writeMixedClipboard(clipboard, StrictClipboardItem).then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(writes, 1);
  commit();
  await pending;
  assert.equal(finished, true);
});

test('controlled restore comparison preserves complete plain and HTML bytes and detects either corruption', async () => {
  const f = fixture();
  await writeMixedClipboard(f.clipboard, StrictClipboardItem);
  const original = await readMixedClipboard(f.clipboard);
  f.setItems([createMixedClipboardItem(StrictClipboardItem)]);
  assert.deepEqual(await readMixedClipboard(f.clipboard), original);
  for (const mime of ['text/plain', 'text/html']) {
    const restored = createMixedClipboardItem(StrictClipboardItem);
    restored.payloads[mime] = 'Changed representation';
    f.setItems([restored]);
    const actual = await readMixedClipboard(f.clipboard);
    assert.throws(() => assert.deepEqual(actual, original));
  }
});

test('MIME snapshots preserve bytes that text decoding would normalize', async () => {
  const plain = Buffer.from([0xef, 0xbb, 0xbf, 65, 0, 0xff]), html = Buffer.from([60, 98, 62, 0, 255]);
  const item = new StrictClipboardItem({ 'text/plain': new Blob([plain], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }) });
  const f = fixture();
  f.setItems([item]);
  assert.deepEqual(await readMixedClipboard(f.clipboard), { text: plain, html });
});
