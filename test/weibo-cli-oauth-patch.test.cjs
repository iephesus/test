'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BROKEN, FIXED, patchSource, apply } = require('../scripts/fix-weibo-cli-open-browser.cjs');

test('oauth patch replaces cmd start with rundll32 FileProtocolHandler', () => {
  const source = 'prefix\n' + BROKEN + '\nsuffix';
  const once = patchSource(source);
  assert.equal(once.status, 'patched');
  assert.equal(once.source.includes("args = ['/c', 'start'"), false);
  assert.match(once.source, /rundll32\.exe/);
  assert.match(once.source, /url\.dll,FileProtocolHandler/);
  assert.equal(patchSource(once.source).status, 'already');
});

test('oauth patch skips unknown shapes instead of rewriting blindly', () => {
  const result = patchSource("else if (platform === 'win32') { open(url); }");
  assert.equal(result.status, 'skipped');
  assert.equal(result.source.includes('rundll32'), false);
});

test('oauth apply writes only when the known broken snippet is present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-oauth-patch-'));
  const file = path.join(dir, 'oauth.js');
  try {
    fs.writeFileSync(file, 'head\n' + BROKEN + '\ntail');
    assert.equal(apply(file).status, 'patched');
    assert.equal(fs.readFileSync(file, 'utf8'), 'head\n' + FIXED + '\ntail');
    assert.equal(apply(file).status, 'already');
    assert.equal(apply(path.join(dir, 'missing.js')).status, 'missing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installed weibo-cli oauth.js is patched or absent', () => {
  const target = path.join(__dirname, '../node_modules/@weibo-ai/weibo-cli/dist/oauth.js');
  if (!fs.existsSync(target)) return;
  const source = fs.readFileSync(target, 'utf8');
  assert.match(source, /url\.dll,FileProtocolHandler/);
  assert.equal(source.includes(BROKEN), false);
});
