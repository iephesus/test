'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sync = require('../lib/fs-sync');
const durable = require('../lib/durable-write');

test('directory sync tolerates Windows EPERM and durable-write still lands bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-fs-sync-'));
  try {
    assert.doesNotThrow(() => sync.directory(dir));
    const file = path.join(dir, 'note.json');
    const hash = durable.atomic(file, { ok: true, platform: process.platform });
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true, platform: process.platform });
    assert.doesNotThrow(() => sync.path(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('request-journal durable write survives Windows directory fsync limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-journal-sync-'));
  try {
    const file = path.join(dir, 'cache', 'request-journal', 'demo.response.json');
    // Mirror the private durable() path via response capture surface is heavy;
    // exercise the shared helpers the journal now calls.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({ schema: 1, ok: true }));
      sync.file(fd);
    } finally {
      fs.closeSync(fd);
    }
    assert.doesNotThrow(() => sync.directory(path.dirname(file)));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
