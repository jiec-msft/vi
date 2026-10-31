const path = require('node:path');

const LIMITS = Object.freeze({ text: 262144, configBytes: 65536, manifestBytes: 16384,
  packageBytes: 8 * 1024 * 1024, files: 256, enabled: 8, initMs: 2000,
  previewMs: 100, callMs: 1500, finalMs: 5000 });
const HOOKS = Object.freeze(['preview.transform', 'final.transform', 'output.guard']);
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;

function failure(code, pluginId) {
  return Object.assign(new Error(`Plugin ${pluginId || 'host'}: ${code}.`),
    { code, pluginId, pluginFailure: true });
}

function jsonValue(value) {
  const ancestors = new Set();
  const inspect = (item, depth) => {
    if (depth > 16 || item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
        typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) throw failure('invalid-config');
    if (item && typeof item === 'object') {
      if (ancestors.has(item) || !['[object Object]', '[object Array]'].includes(Object.prototype.toString.call(item))) {
        throw failure('invalid-config');
      }
      ancestors.add(item);
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw failure('invalid-config');
        inspect(child, depth + 1);
      }
      ancestors.delete(item);
    }
  };
  inspect(value, 0);
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw failure('invalid-config'); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > LIMITS.configBytes) throw failure('invalid-config');
  return JSON.parse(encoded);
}

function manifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Buffer.byteLength(JSON.stringify(value)) > LIMITS.manifestBytes ||
      !ID.test(value.id) || value.id.length > 100 ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      value.apiVersion !== 1 || typeof value.entry !== 'string' ||
      /[\\<>:"|?*\x00-\x1f]/u.test(value.entry) || path.posix.isAbsolute(value.entry) ||
      value.entry.split('/').some((part) => !part || part === '.' || part === '..') ||
      !/\.cjs$/.test(value.entry) ||
      !Array.isArray(value.hooks) || !value.hooks.length ||
      new Set(value.hooks).size !== value.hooks.length || value.hooks.some((hook) => !HOOKS.includes(hook)) ||
      (value.privacy !== undefined && (!value.privacy || typeof value.privacy.suppressUnprocessed !== 'boolean')) ||
      (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 500))) {
    throw failure('invalid-manifest');
  }
  return { id: value.id, version: value.version, apiVersion: 1, entry: value.entry,
    hooks: [...value.hooks], privacy: { suppressUnprocessed: value.privacy?.suppressUnprocessed ?? false },
    description: value.description || '' };
}

function text(value, pluginId) {
  if (typeof value !== 'string' || value.length > LIMITS.text || value.includes('\0')) {
    throw failure('invalid-text', pluginId);
  }
  return value;
}

function result(value, hook, pluginId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid-result', pluginId);
  const allowed = hook === 'output.guard' ? ['allow', 'block']
    : hook === 'preview.transform' ? ['keep', 'replace'] : ['keep', 'replace', 'suppress', 'block'];
  if (!allowed.includes(value.outcome) || Object.keys(value).some((key) => !['outcome', 'text', 'count'].includes(key)) ||
      (value.text !== undefined && value.outcome !== 'replace') ||
      (value.count !== undefined && (!Number.isSafeInteger(value.count) || value.count < 0))) {
    throw failure('invalid-result', pluginId);
  }
  if (value.outcome === 'replace') text(value.text, pluginId);
  return { outcome: value.outcome, ...(value.outcome === 'replace' ? { text: value.text } : {}),
    ...(value.count !== undefined ? { count: value.count } : {}) };
}

function pluginPreferences(saved = {}) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
      (saved.trustedLocal !== undefined && typeof saved.trustedLocal !== 'boolean') ||
      (saved.profile !== undefined && !['general', 'developer'].includes(saved.profile)) ||
      (saved.entries !== undefined && (!Array.isArray(saved.entries) || saved.entries.length > 64))) throw failure('invalid-settings');
  const entries = (saved.entries || []).map((entry) => {
    if (!entry || typeof entry.id !== 'string' || entry.id.length > 100 || !ID.test(entry.id) || typeof entry.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.enabled !== 'boolean') throw failure('invalid-settings');
    return { id: entry.id, hash: entry.hash, enabled: entry.enabled,
      ...(Object.hasOwn(entry, 'config') ? { config: jsonValue(entry.config) } : {}) };
  });
  if (entries.length > 64 || new Set(entries.map((entry) => entry.id)).size !== entries.length ||
      entries.filter((entry) => entry.enabled).length > LIMITS.enabled) throw failure('invalid-settings');
  return { trustedLocal: saved.trustedLocal ?? false, profile: saved.profile ?? 'developer', entries };
}

module.exports = { LIMITS, HOOKS, failure, manifest, text, result, jsonValue, pluginPreferences };
