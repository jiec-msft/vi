function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

function markerPlacement(caret, monitor) {
  const width = Math.ceil(24 * monitor.scale);
  const height = Math.ceil(28 * monitor.scale);
  const gap = Math.ceil(6 * monitor.scale);
  const center = caret.x + caret.width / 2;
  const candidates = [
    { x: center - width / 2, y: caret.y + caret.height + gap },
    { x: center - width / 2, y: caret.y - gap - height },
    { x: caret.x + caret.width + gap, y: caret.y },
    { x: caret.x - gap - width, y: caret.y },
  ];
  for (const position of candidates) {
    const rect = { x: Math.floor(position.x), y: Math.floor(position.y), width, height };
    if (contains(monitor.workArea, rect) && !overlaps(rect, caret)) return rect;
  }
  return null;
}

module.exports = { contains, overlaps, markerPlacement };
