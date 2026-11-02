const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fileInventory(directory) {
  const result = {};
  function visit(relative) {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const key = relative ? `${relative}/${name}` : name;
      const file = path.join(directory, key);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) result[key] = { link: fs.readlinkSync(file) };
      else if (stat.isDirectory()) visit(key);
      else if (stat.isFile()) result[key] = { bytes: stat.size, sha256: digest(file), mode: stat.mode & 0o777 };
      else throw new Error('Unsupported distribution filesystem entry.');
    }
  }
  visit('');
  return result;
}

function regularProviderInventory(root) {
  const files = fileInventory(root);
  if (Object.values(files).some((item) => item.link !== undefined)) throw new Error('Provider dependencies cannot contain symlinks.');
  return files;
}

module.exports = { digest, fileInventory, regularProviderInventory };
