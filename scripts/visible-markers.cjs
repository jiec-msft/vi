function fiveMarkersVisible(pixels, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      pixels.length !== width * height * 4) throw new Error('Invalid desktop bitmap.');
  const marked = new Uint8Array(width * height);
  for (let i = 0; i < marked.length; i++) {
    const offset = i * 4;
    marked[i] = Number(pixels[offset] >= 240 && pixels[offset + 1] <= 15 && pixels[offset + 2] >= 240);
  }
  let regions = 0;
  for (let i = 0; i < marked.length; i++) {
    if (!marked[i]) continue;
    const queue = [i];
    marked[i] = 0;
    let count = 0;
    while (queue.length) {
      const current = queue.pop();
      count++;
      for (const next of [current - width, current + width,
        ...(current % width ? [current - 1] : []),
        ...(current % width < width - 1 ? [current + 1] : [])]) {
        if (next >= 0 && next < marked.length && marked[next]) { marked[next] = 0; queue.push(next); }
      }
    }
    if (count >= 100) regions++;
  }
  return regions === 5;
}
module.exports = { fiveMarkersVisible };
