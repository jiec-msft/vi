const { compile, normalize } = require('./matcher.cjs');
let compiled, configuration;
function prepare(config) {
  if (config !== configuration) {
    compiled = compile(config);
    configuration = config;
  }
  return compiled;
}
module.exports = {
  validateConfig(config) { prepare(config); return { valid: true }; },
  hooks: {
    'final.transform'({ inputText, config, context }) {
      const value = normalize(inputText, prepare(config), context.profile);
      return value.count ? { outcome: 'replace', text: value.text, count: value.count } : { outcome: 'keep', count: 0 };
    },
  },
};
