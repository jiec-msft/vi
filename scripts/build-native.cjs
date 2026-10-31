const { execFileSync } = require('node:child_process');
const path = require('node:path');
if (process.platform === 'darwin') {
  execFileSync('swiftc', [path.join('native', 'macos-delivery.swift'), '-o', path.join('native', 'macos-delivery')],
    { stdio: 'inherit', timeout: 60000 });
}
