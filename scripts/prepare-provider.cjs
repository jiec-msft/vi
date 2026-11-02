const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const url = 'https://github.com/jiec-msft/vi-provider/releases/download/v0.1.1/vi-service-provider-0.1.1.tgz';
const expected = '2c175cad0873cd4d56a02213c56926b415db5f4f4bd818ace1ec67f32c867e5c';

async function prepareProvider(directory = path.resolve('artifacts-ci', 'provider')) {
  await fs.mkdir(directory, { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Public provider download failed.');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 10485760) throw new Error('Public provider exceeds its download limit.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Provider checksum mismatch.');
  const archive = path.join(directory, 'provider.tgz');
  await fs.writeFile(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  return { url, sha256: expected };
}
module.exports = { prepareProvider, url, expected };
if (require.main === module) {
  prepareProvider().then(() => {
    console.log('Public provider checksum and extraction passed.');
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
