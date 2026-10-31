(() => {
  const element = (id) => document.getElementById(id);
  let canOriginal = false, resultId, busy = false, pending = false, warningText = '';
  const report = (message, error = false) => {
    element('plugin-result').textContent = [message, warningText].filter(Boolean).join(' ');
    element('plugin-result').classList.toggle('error', error);
  };
  const lock = () => { element('plugin-fields').disabled = busy || pending; };
  async function action(callback) {
    report('');
    try { await callback(); }
    catch (error) { report(error.message, true); }
  }
  function render(value) {
    const list = element('plugin-list');
    list.replaceChildren();
    for (const plugin of value.plugins) {
      const label = document.createElement('label');
      label.className = 'consent';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = plugin.enabled;
      toggle.disabled = plugin.unavailable && !plugin.enabled;
      toggle.onchange = () => action(async () => {
        const enabled = toggle.checked;
        pending = true;
        lock();
        try {
          render(await window.voice.setPluginEnabled(plugin.id, enabled));
          report('Plugin state saved. Previous transcript cleared.');
        } catch (error) {
          toggle.checked = plugin.enabled;
          throw error;
        } finally { pending = false; lock(); }
      });
      label.append(toggle, document.createTextNode(`${plugin.id}${plugin.unavailable ? ' (files unavailable)' : ''}`));
      list.append(label);
    }
    if (!value.plugins.length) list.textContent = 'No plugins found.';
  }
  async function load() {
    if (busy || pending) return;
    pending = true;
    lock();
    try { render(await window.voice.plugins()); }
    finally { pending = false; lock(); }
  }
  element('show-original').onclick = () => action(async () => {
    const raw = await window.voice.original();
    if (!canOriginal || raw.resultId !== resultId) return;
    element('original-result').value = raw.text;
    element('original-result').hidden = false;
  });
  element('copy-original').onclick = () => action(() => window.voice.copyOriginal());
  window.voice.onStatus((status) => {
    warningText = (status.pluginWarnings || []).join(' ');
    report('');
    busy = status.pluginChanging || status.testingMic || status.checkingAuth ||
      ['preparing', 'recording', 'finishing', 'cancelling'].includes(status.phase);
    lock();
    canOriginal = status.canOriginal;
    resultId = status.resultId;
    element('show-original').disabled = !canOriginal;
    element('copy-original').disabled = !canOriginal;
    if (!canOriginal) {
      element('original-result').value = '';
      element('original-result').hidden = true;
    }
  });
  window.addEventListener('focus', () => { void action(load); });
  void action(load);
})();
