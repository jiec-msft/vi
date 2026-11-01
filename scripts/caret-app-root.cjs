const { stage } = require('./caret-bootstrap-trace.cjs');
stage('entry-loaded');
require('./windows-hosted-guard.cjs').hostedGuard();
const acceptance = require('./windows-caret-ui.cjs');
stage('app-import-before');
require('../app/main.cjs');
stage('app-import-after');
acceptance.runAcceptance();
