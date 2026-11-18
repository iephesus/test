'use strict';
// Trim Electron leftovers that ship by default but are unused by Reader.
// Keep LICENSE.electron.txt; drop the multi-megabyte Chromium license dump
// and any locale packs outside the configured electronLanguages set.
const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set(['en-US.pak', 'zh-CN.pak']);

function removeIfPresent(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const out = context.appOutDir;
  removeIfPresent(path.join(out, 'LICENSES.chromium.html'));

  const locales = path.join(out, 'locales');
  if (!fs.existsSync(locales)) return;
  for (const name of fs.readdirSync(locales)) {
    if (!KEEP_LOCALES.has(name)) removeIfPresent(path.join(locales, name));
  }
}

module.exports = afterPack;
module.exports.KEEP_LOCALES = KEEP_LOCALES;
module.exports.removeIfPresent = removeIfPresent;
