'use strict';
// Windows packaging with optional Authenticode signing.
// Unsigned (default): CSC_IDENTITY_AUTO_DISCOVERY=false, no winCodeSign symlink needs.
// Signed: set CSC_LINK (or WIN_CSC_LINK) to a .pfx path/URL and CSC_KEY_PASSWORD.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const link = String(process.env.CSC_LINK || process.env.WIN_CSC_LINK || '').trim();
const password = String(process.env.CSC_KEY_PASSWORD || process.env.WIN_CSC_KEY_PASSWORD || '');
const signed = !!link;

const env = { ...process.env };
if (process.env.WIN_CSC_LINK && !process.env.CSC_LINK) env.CSC_LINK = process.env.WIN_CSC_LINK;
if (process.env.WIN_CSC_KEY_PASSWORD && !process.env.CSC_KEY_PASSWORD) {
  env.CSC_KEY_PASSWORD = process.env.WIN_CSC_KEY_PASSWORD;
}

const args = ['electron-builder', '--win'];
if (signed) {
  if (!password) {
    console.error('CSC_LINK is set but CSC_KEY_PASSWORD / WIN_CSC_KEY_PASSWORD is empty.');
    process.exit(1);
  }
  console.log('Packaging Windows build with code signing enabled.');
  args.push('--config.win.signAndEditExecutable=true');
} else {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('Packaging unsigned Windows build (set CSC_LINK + CSC_KEY_PASSWORD to sign).');
  args.push('--config.win.signAndEditExecutable=false');
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, args, { cwd: root, env, stdio: 'inherit', shell: true });
process.exit(result.status == null ? 1 : result.status);
