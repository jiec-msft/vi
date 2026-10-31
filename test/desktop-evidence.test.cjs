const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fiveMarkersVisible } = require('../scripts/visible-markers.cjs');
function bitmap(count, alpha = 255) {
  const pixels = Buffer.alloc(200 * 100 * 4);
  for (let marker = 0; marker < count; marker++) {
    for (let y = 10; y < 22; y++) for (let x = marker * 35 + 10; x < marker * 35 + 22; x++) {
      const offset = (y * 200 + x) * 4;
      pixels[offset] = pixels[offset + 2] = 255;
      pixels[offset + 3] = alpha;
    }
  }
  return pixels;
}
test('desktop visibility requires five separate visible regions', () => {
  assert.equal(fiveMarkersVisible(bitmap(5), 200, 100), true);
  for (const count of [0, 1, 4]) assert.equal(fiveMarkersVisible(bitmap(count), 200, 100), false);
});
test('Windows bitmap alpha does not hide otherwise visible RGB markers', () => {
  assert.equal(fiveMarkersVisible(bitmap(5, 0), 200, 100), true);
});
test('a large single magenta surface cannot pass the visibility gate', () => {
  const pixels = Buffer.alloc(200 * 100 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = pixels[offset + 2] = 255;
  }
  assert.equal(fiveMarkersVisible(pixels, 200, 100), false);
});
test('invalid capture shape fails explicitly', () => {
  assert.throws(() => fiveMarkersVisible(Buffer.alloc(4), 200, 100), /Invalid desktop bitmap/);
});
