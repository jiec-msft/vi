const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { NativeDelivery } = require('../../app/native-delivery.cjs');

test('Windows delivery helper compiles and answers readiness without desktop or clipboard access',
  { skip: process.platform !== 'win32' }, async () => {
    const driver = new NativeDelivery('win32', path.resolve('native'));
    try { assert.deepEqual(await driver.request('ready'), { ready: true }); }
    finally { driver.close(); }
  });
