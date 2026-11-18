'use strict';
// Keep Windows browser OAuth usable after npm install. weibo-cli opens URLs with
// `cmd /c start`, which truncates query strings at `&` and drops PKCE fields.
const fs = require('node:fs');
const path = require('node:path');

const BROKEN = `else if (platform === 'win32') {
        cmd = 'cmd';
        args = ['/c', 'start', '""', url];
    }`;
const FIXED = `else if (platform === 'win32') {
        // cmd \`start\` re-parses & in the URL as command separators, dropping
        // OAuth query fields such as redirect_uri and code_challenge.
        cmd = 'rundll32.exe';
        args = ['url.dll,FileProtocolHandler', url];
    }`;

function patchSource(source) {
  if (source.includes('url.dll,FileProtocolHandler')) return { status: 'already', source };
  if (!source.includes(BROKEN)) return { status: 'skipped', source };
  return { status: 'patched', source: source.replace(BROKEN, FIXED) };
}

function apply(target = path.join(__dirname, '..', 'node_modules', '@weibo-ai', 'weibo-cli', 'dist', 'oauth.js')) {
  if (!fs.existsSync(target)) return { status: 'missing', target };
  const result = patchSource(fs.readFileSync(target, 'utf8'));
  if (result.status === 'patched') fs.writeFileSync(target, result.source);
  return { ...result, target };
}

if (require.main === module) {
  const result = apply();
  if (result.status === 'already') console.log('weibo-cli Windows browser open already patched');
  else if (result.status === 'patched') console.log('patched weibo-cli Windows browser open');
  else if (result.status === 'skipped') console.warn('weibo-cli oauth.js win32 openBrowser shape changed; skip patch');
  process.exit(0);
}

module.exports = { BROKEN, FIXED, patchSource, apply };
