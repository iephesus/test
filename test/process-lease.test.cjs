'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lease = require('../lib/process-lease');

test('processBirth returns a stable marker for the current process', {
  skip: ['win32', 'linux', 'darwin'].includes(process.platform) ? false : 'unsupported platform'
}, () => {
  const birth = lease.processBirth(process.pid);
  assert.ok(birth);
  assert.equal(typeof birth, 'string');
  if (process.platform === 'win32') assert.ok(Number.isFinite(Date.parse(birth)));
});

test('running rejects live PID when birth token does not match', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const birth = lease.processBirth(child.pid);
    if (!birth) {
      assert.equal(lease.running({ pid: child.pid, birth: 'x', legacy: false }, () => null), true);
      return;
    }
    assert.equal(lease.running({ pid: child.pid, birth, legacy: false }), true);
    assert.equal(lease.running({ pid: child.pid, birth: birth + '-mismatch', legacy: false }), false);
  } finally {
    child.kill();
  }
});

test('renameConflict treats Windows EPERM as destination collision', () => {
  assert.equal(lease.renameConflict({ code: 'EEXIST' }), true);
  assert.equal(lease.renameConflict({ code: 'ENOENT' }), false);
  if (process.platform === 'win32') {
    assert.equal(lease.renameConflict({ code: 'EPERM' }), true);
    assert.equal(lease.renameConflict({ code: 'EACCES' }), true);
  } else {
    assert.equal(lease.renameConflict({ code: 'EPERM' }), false);
  }
});

test('acquire replaces a stale empty session.lock directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-lease-'));
  const file = path.join(dir, 'session.lock');
  fs.mkdirSync(file);
  try {
    const held = lease.acquire(file, 'busy');
    assert.ok(held.owned());
    held.release();
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquire recovers after a forced Windows EPERM rename against a stale lock', {
  skip: process.platform !== 'win32' ? 'Windows rename EPERM semantics' : false
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-lease-eperm-'));
  const file = path.join(dir, 'session.lock');
  fs.mkdirSync(file);
  const original = fs.renameSync;
  let forced = 0;
  fs.renameSync = (from, to) => {
    if (to === file && forced < 1) {
      forced += 1;
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }
    return original.call(fs, from, to);
  };
  try {
    const held = lease.acquire(file, 'busy');
    assert.equal(forced, 1);
    assert.ok(held.owned());
    held.release();
  } finally {
    fs.renameSync = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
