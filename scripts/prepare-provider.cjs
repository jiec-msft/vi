const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function main() {
  const url = 'https://github.com/jiec-msft/vi-provider/releases/download/v0.1.1/vi-service-provider-0.1.1.tgz';
  const expected = '2c175cad0873cd4d56a02213c56926b415db5f4f4bd818ace1ec67f32c867e5c';
  const directory = path.resolve('artifacts-ci', 'provider');
  await fs.mkdir(directory, { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Public provider download failed.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Provider checksum mismatch.');
  const archive = path.join(directory, 'provider.tgz');
  await fs.writeFile(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  console.log('Public provider checksum and extraction passed.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
