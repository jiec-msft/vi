const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, normalize } = require('../../app/plugins/builtin/technical-vocabulary/matcher.cjs');
const defaults = require('../../app/plugins/builtin/technical-vocabulary/config.json');
const plugin = require('../../app/plugins/builtin/technical-vocabulary/index.cjs');
const regressionConfig = require('../evaluation/vocabulary/regression-config.json');
const basic = require('../docs/technical-vocabulary/cases.json');
const challenges = require('../docs/technical-vocabulary/challenge-cases.json');

test('fixed research dictionary preserves covered positives and authored negatives', () => {
  const config = compile(regressionConfig);
  for (const sample of basic.filter((item) => item.kind !== 'uncovered')) {
    assert.equal(normalize(sample.input, config, sample.profile || 'developer').text, sample.expected, sample.id);
  }
});
test('known quote/metalinguistic false changes are fixed; English context and sentence period work', () => {
  const config = compile(regressionConfig);
  for (const sample of challenges.filter((item) => item.kind === 'negative' || ['h01', 'h08', 'h09'].includes(item.id))) {
    assert.equal(normalize(sample.input, config, 'developer').text, sample.expected, sample.id);
  }
  assert.equal(normalize('用 make dear 创建路径', config, 'developer').count, 0);
});
test('English contractions do not open quoted spans and actual single-quoted aliases remain protected', () => {
  const config = compile(regressionConfig);
  for (const [input, expected] of [
    ["Please don't run make dir.", "Please don't run mkdir."],
    ["Let's run make dir", "Let's run mkdir"],
    ["I can't run make dir.", "I can't run mkdir."],
    ["Don't run 'make dir'.", "Don't run 'make dir'."],
    ["Let's run 'make dir", "Let's run 'make dir"],
    ["用'make dir'创建目录", "用'make dir'创建目录"],
    ["Run 'make dir' then run make dir.", "Run 'make dir' then run mkdir."],
  ]) assert.equal(normalize(input, config, 'developer').text, expected, input);
});
test('shipped dictionary applies its configured literal aliases independently of research fixtures', () => {
  const config = compile(defaults);
  for (const rule of defaults.rules) {
    assert.equal(normalize(`运行 ${rule.alias} 命令`, config, 'developer').text, `运行 ${rule.target} 命令`);
  }
  assert.equal(normalize('kube c t l有哪些常用的命令？', config, 'developer').text, 'kubectl有哪些常用的命令？');
  assert.equal(normalize('KubeCTL有哪些常用的命令？', config, 'developer').count, 0,
    'spaced aliases do not imply compact spelling aliases');
});
test('longest original-input spans apply once, without cascades or replacement-string expansion', () => {
  const config = compile({ scope: 'all', rules: [
    { alias: 'alpha', target: 'beta' }, { alias: 'beta', target: 'gamma' },
    { alias: 'alpha beta', target: '$&' },
  ] });
  assert.equal(normalize('alpha beta alpha', config, 'general').text, '$& beta');
});
test('invalid, conflicting and oversized dictionaries are rejected', () => {
  for (const config of [{ rules: [{ alias: '', target: 'x' }] }, { rules: [{ alias: 'a', target: '\0' }] },
    { rules: [{ alias: 'make dir', target: 'a' }, { alias: 'MAKE  DIR', target: 'b' }] },
    { rules: Array.from({ length: 501 }, (_, i) => ({ alias: `a${i}`, target: 'a' })) }]) {
    assert.throws(() => compile(config));
  }
});
test('Unicode aliases never split emoji modifiers, flags or grapheme clusters', () => {
  const config = compile({ scope: 'all', rules: [{ alias: '👍', target: 'ok' }, { alias: '🇺', target: 'flag' }] });
  assert.equal(normalize('👍🏻 🇺🇸 👍', config, 'general').text, '👍🏻 🇺🇸 ok');
});
test('public plugin returns keep when disabled by profile and replace when configured', async () => {
  assert.deepEqual(plugin.validateConfig(defaults), { valid: true });
  const transform = plugin.hooks['final.transform'];
  assert.equal((await transform({ config: defaults, inputText: '用make dir', context: { profile: 'developer' } })).text, '用mkdir');
  assert.equal((await transform({ config: defaults, inputText: '用make dir', context: { profile: 'general' } })).outcome, 'keep');
});
