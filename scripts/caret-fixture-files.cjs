const path = require('node:path');
const { performance } = require('node:perf_hooks');
const roles = new Set(['mkdir-fixture', 'write-plugin', 'write-config', 'write-index', 'write-settings']);

function fixtureFiles({ root, fs, stage }) {
  root = path.resolve(root);
  const bound = (work, ms) => {
    let timer;
    return Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Controlled fixture FS deadline exceeded.'), { code: 'FIXTURE_FS_TIMEOUT' })), ms);
    })]).finally(() => clearTimeout(timer));
  };
  function owned(file) {
    file = path.resolve(file);
    if (file !== root && !file.startsWith(root + path.sep))
      throw Object.assign(new Error('Controlled fixture path escaped its layout.'), { code: 'UNSAFE_FIXTURE_PATH' });
    return file;
  }
  async function validate(file, operation) {
    file = owned(file);
    stage('fs-validation-before', undefined, { operation });
    let current = file;
    for (;;) {
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw Object.assign(new Error('Controlled fixture path is a link.'), { code: 'UNSAFE_FIXTURE_PATH' });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current === root) break;
      current = owned(path.dirname(current));
    }
    stage('fs-validation-after', undefined, { operation });
    return file;
  }
  async function run(operation, file, action) {
    if (!roles.has(operation)) throw new Error('Invalid controlled FS operation.');
    file = owned(file);
    const started = performance.now();
    stage('fs-before', undefined, { operation });
    try {
      const value = await bound((async () => {
        await validate(file, operation);
        stage('fs-action-before', undefined, { operation });
        return action();
      })(), 5000);
      stage('fs-after', undefined, { operation, elapsedMs: Math.round(performance.now() - started) });
      return value;
    } catch (error) {
      stage(error.code === 'FIXTURE_FS_TIMEOUT' ? 'fs-timeout' : 'fs-rejected', error,
        { operation, elapsedMs: Math.round(performance.now() - started) });
      try {
        const stat = await bound(fs.lstat(file), 1000);
        stage('fs-observation', undefined, { operation, exists: true, bytes: stat.size, parentRole: 'owned-layout' });
      } catch (observation) {
        stage('fs-observation', undefined, { operation, exists: observation.code === 'ENOENT' ? false : undefined,
          observerUnavailable: observation.code !== 'ENOENT', parentRole: 'owned-layout' });
      }
      throw error;
    }
  }
  return { run };
}
module.exports = { fixtureFiles };
