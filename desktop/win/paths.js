'use strict';
// Resolve UI (asar) vs engine (must be real files for ELECTRON_RUN_AS_NODE).
const fs = require('node:fs');
const path = require('node:path');

function resolveAppRoots({ isPackaged, appPath, resourcesPath, existsSync = fs.existsSync } = {}) {
  if (!isPackaged) {
    return { appRoot: appPath, engineRoot: appPath };
  }
  const unpacked = path.join(resourcesPath, 'app.asar.unpacked');
  const engineRoot = existsSync(path.join(unpacked, 'desktop', 'bridge.js')) ? unpacked : appPath;
  return { appRoot: appPath, engineRoot };
}

module.exports = { resolveAppRoots };
