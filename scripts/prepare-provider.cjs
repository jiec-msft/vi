const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function main() {
  const url = 'https://github.com/jiec-msft/vi-provider/releases/download/v0.1.0/vi-service-provider-0.1.0.tgz';
  const expected = '8e16c6576c1d2122a6fc0f6d4d009d740ddb190f9e065a022953e2a838eca765';
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
