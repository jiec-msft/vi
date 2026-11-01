const { hostedGuard } = require('./windows-ci-desktop-probe.cjs');
hostedGuard();
require('electron').app.whenReady().then(() => require('electron').app.exit(37));
