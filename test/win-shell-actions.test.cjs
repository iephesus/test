'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FORWARD_ACTIONS, LOCAL_ACTIONS, TRANSPORT_SAFE, isKnownAction } = require('../desktop/win/shell-actions');

test('Windows shell forwards paid-quote and core acquisition actions', () => {
  for (const action of ['pricingQuote', 'pricingReference', 'pricingRefresh', 'run', 'stop', 'login', 'account']) {
    assert.equal(FORWARD_ACTIONS.has(action), true, action);
  }
  assert.equal(isKnownAction('pricingQuote'), true);
  assert.equal(isKnownAction('chooseWorkspace'), false);
});

test('macOS Swift still lists pricingQuote with other forward actions', () => {
  const swift = fs.readFileSync(path.join(__dirname, '../desktop/WeiboReader.swift'), 'utf8');
  assert.match(swift, /"pricingQuote"/);
  assert.match(swift, /"pricingReference", "pricingRefresh", "pricingQuote"/);
  for (const action of ['run', 'login', 'manageBatch', 'profilesRefresh']) {
    assert.match(swift, new RegExp('"' + action + '"'));
  }
});

test('Electron main consumes the shared shell-actions catalog', () => {
  const main = fs.readFileSync(path.join(__dirname, '../desktop/win/main.js'), 'utf8');
  assert.match(main, /require\('\.\/shell-actions'\)/);
  assert.equal(LOCAL_ACTIONS.has('localExport'), true);
  assert.equal(TRANSPORT_SAFE.has('ready'), true);
  assert.equal(FORWARD_ACTIONS.has('chooseWorkspace'), false);
});
