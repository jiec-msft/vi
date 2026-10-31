const fold = (value) => value.toLowerCase().replace(/[ \t\u00a0]+/gu, ' ');
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(config) {
  if (!config || !['developer', 'all'].includes(config.scope ?? 'developer') ||
      !Array.isArray(config.rules) || config.rules.length > 500) throw new Error('Invalid vocabulary configuration.');
  const seen = new Set();
  const rules = config.rules.map((rule, id) => {
    if (!rule || typeof rule.alias !== 'string' || typeof rule.target !== 'string' ||
        !rule.alias.trim() || rule.alias.trim() !== rule.alias || !rule.target.trim() ||
        rule.alias.length > 128 || rule.target.length > 256 || !rule.alias.isWellFormed() ||
        !rule.target.isWellFormed() || /[\x00-\x1f\x7f]/u.test(rule.alias + rule.target) ||
        (rule.context !== undefined && typeof rule.context !== 'boolean')) throw new Error('Invalid vocabulary rule.');
    const key = fold(rule.alias);
    if (seen.has(key)) throw new Error('Conflicting vocabulary aliases.');
    seen.add(key);
    return { ...rule, id, pattern: new RegExp(key.split(' ').map(escape).join('[ \\t\\u00a0]+'), 'giu') };
  });
  return { scope: config.scope ?? 'developer', rules };
}

function identifier(character) {
  return Boolean(character && !/\p{Script=Han}/u.test(character) &&
    /[\p{L}\p{N}\p{M}_./\\-]/u.test(character));
}

function normalize(input, compiled, profile) {
  if (typeof input !== 'string' || input.length > 262144 || input.includes('\0')) throw new Error('Invalid vocabulary input.');
  if ((compiled.scope === 'developer' && profile !== 'developer') ||
      /原样|不要(?:把[^。！？\n]*?)?(?:替换|转换)|读作|发音|这两个词|这个短语|字面|\b(?:phrase|literal|pronounce|spelled|words?)\b/iu.test(input)) {
    return { text: input, count: 0 };
  }
  const protectedPattern = /`[^`]*(?:`|$)|"[^"\n]*(?:"|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|(?<![A-Za-z0-9])'[^'\n]*(?:'|$)|https?:\/\/[^\s，。！？]+/gu;
  const protectedRanges = [...input.matchAll(protectedPattern)].map((match) => [match.index, match.index + match[0].length]);
  const candidates = [];
  let graphemeBoundaries;
  for (const rule of compiled.rules) {
    for (const match of input.matchAll(rule.pattern)) {
      const start = match.index, end = start + match[0].length;
      if (/[^\x00-\x7f]/u.test(rule.alias)) {
        if (!graphemeBoundaries) {
          graphemeBoundaries = new Set([input.length]);
          for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input)) {
            graphemeBoundaries.add(segment.index);
          }
        }
        if (!graphemeBoundaries.has(start) || !graphemeBoundaries.has(end)) continue;
      }
      const before = Array.from(input.slice(Math.max(0, start - 2), start)).at(-1);
      const after = end < input.length ? String.fromCodePoint(input.codePointAt(end)) : '';
      const sentencePeriod = after === '.' && (end + 1 === input.length ||
        /[\s，。！？、）)\]}]/u.test(input[end + 1]));
      if (identifier(before) || (identifier(after) && !sentencePeriod) ||
          /[\u200d\ufe00-\ufe0f]/u.test(before || '') || /[\u200d\ufe00-\ufe0f]/u.test(after) ||
          protectedRanges.some(([a, b]) => start < b && end > a)) continue;
      if (rule.context && !/(?:用|运行|执行|输入|敲|通过|打开|访问|(?:run|execute|use|type|open|visit)\s)[ \t]*$/iu
        .test(input.slice(Math.max(0, start - 24), start)) && !/^[ \t]*命令/u.test(input.slice(end))) continue;
      candidates.push({ start, end, target: rule.target, id: rule.id });
      if (candidates.length > 10000) throw new Error('Vocabulary match budget exceeded.');
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end || a.id - b.id);
  let end = 0, output = '', count = 0;
  for (const candidate of candidates) {
    if (candidate.start < end) continue;
    output += input.slice(end, candidate.start) + candidate.target;
    end = candidate.end;
    count++;
    if (output.length > 262144) throw new Error('Vocabulary output budget exceeded.');
  }
  output += input.slice(end);
  if (output.length > 262144) throw new Error('Vocabulary output budget exceeded.');
  return { text: output, count };
}

module.exports = { compile, normalize };
