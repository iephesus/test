'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const account = require('../desktop/ui/account-surface');
const taskCard = require('../desktop/ui/task-card');
const { resolveAppRoots } = require('../desktop/win/paths');
const pkg = require('../package.json');

test('serviceAccountText formats balance and service label', () => {
  const text = account.serviceAccountText(
    { username: 'alice', balance: 12.5, service: 'formal_active' },
    n => String(n)
  );
  assert.match(text, /账户：alice/);
  assert.match(text, /12\.5 credits/);
  assert.match(text, /正式服务/);
});

test('resultExplanationLabel prefers saved feedback issue text', () => {
  assert.equal(taskCard.resultExplanationLabel({ state: 'interrupted' }), '获取已中断');
  assert.equal(taskCard.resultExplanationLabel({
    state: 'partial',
    feedback: { saved: true, middleGap: false, issues: [{ code: 'new', text: '仍有缺口' }] }
  }), '仍有缺口');
});

test('resolveAppRoots prefers asar.unpacked when bridge is present', () => {
  const seen = [];
  const roots = resolveAppRoots({
    isPackaged: true,
    appPath: 'C:\\App\\resources\\app.asar',
    resourcesPath: 'C:\\App\\resources',
    existsSync: file => {
      seen.push(file.replace(/\\/g, '/'));
      return file.replace(/\\/g, '/').endsWith('app.asar.unpacked/desktop/bridge.js');
    }
  });
  assert.equal(roots.appRoot, 'C:\\App\\resources\\app.asar');
  assert.match(roots.engineRoot.replace(/\\/g, '/'), /app\.asar\.unpacked$/);
  assert.ok(seen.some(p => p.endsWith('bridge.js')));
});

test('package.json enables asar with engine unpack globs', () => {
  assert.equal(pkg.build.asar, true);
  assert.ok(pkg.build.asarUnpack.some(p => p.includes('node_modules')));
  assert.ok(pkg.build.asarUnpack.some(p => p.includes('lib')));
  assert.ok(pkg.build.asarUnpack.some(p => p.includes('desktop/*.js')));
  assert.ok(pkg.build.asarUnpack.some(p => p.includes('desktop/ui')));
});
