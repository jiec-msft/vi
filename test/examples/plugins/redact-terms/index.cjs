function valid(config) {
  return Boolean(config && Array.isArray(config.terms) && config.terms.length <= 500 &&
    config.terms.every((term) => typeof term === 'string' && term.length > 0 && term.length <= 128 && !term.includes('\0')) &&
    typeof config.replacement === 'string' && config.replacement.length <= 128 &&
    !config.replacement.includes('\0') && !config.terms.some((term) => config.replacement.includes(term)));
}
module.exports = {
  validateConfig(config) { return { valid: valid(config) }; },
  hooks: {
    'final.transform'({ inputText, config }) {
      let text = inputText;
      for (const term of [...config.terms].sort((a, b) => b.length - a.length)) {
        text = text.split(term).join(config.replacement);
      }
      return text === inputText ? { outcome: 'keep' } : { outcome: 'replace', text };
    },
    'output.guard'({ inputText, config }) {
      return { outcome: config.terms.some((term) => inputText.includes(term)) ? 'block' : 'allow' };
    },
  },
};
