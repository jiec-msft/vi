const { hostedGuard } = require('./windows-hosted-guard.cjs');
hostedGuard();
require('electron').app.whenReady().then(() => require('electron').app.exit(37));
