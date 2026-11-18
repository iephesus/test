'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const afterPack = require('../scripts/after-pack-win.cjs');

test('afterPack removes Chromium license dump and extra locale packs on Windows', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-after-pack-'));
  fs.writeFileSync(path.join(out, 'LICENSES.chromium.html'), 'huge');
  fs.writeFileSync(path.join(out, 'LICENSE.electron.txt'), 'keep');
  const locales = path.join(out, 'locales');
  fs.mkdirSync(locales);
  for (const name of ['en-US.pak', 'zh-CN.pak', 'zh-TW.pak', 'ja.pak']) {
    fs.writeFileSync(path.join(locales, name), name);
  }
  try {
    await afterPack({ electronPlatformName: 'win32', appOutDir: out });
    assert.equal(fs.existsSync(path.join(out, 'LICENSES.chromium.html')), false);
    assert.equal(fs.existsSync(path.join(out, 'LICENSE.electron.txt')), true);
    assert.deepEqual(fs.readdirSync(locales).sort(), ['en-US.pak', 'zh-CN.pak']);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('afterPack ignores non-Windows packs', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-after-pack-mac-'));
  fs.writeFileSync(path.join(out, 'LICENSES.chromium.html'), 'keep-on-mac-hook');
  try {
    await afterPack({ electronPlatformName: 'darwin', appOutDir: out });
    assert.equal(fs.existsSync(path.join(out, 'LICENSES.chromium.html')), true);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
