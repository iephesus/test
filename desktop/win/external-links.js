'use strict';

// Port of desktop/ExternalLinks.swift — only explicit canonical URLs.
function managementExternalURL(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) >= 200 || raw.includes('%') || raw.includes('\\') || /\s/.test(raw)) return null;
  let parts;
  try { parts = new URL(raw); } catch { return null; }
  if (parts.protocol !== 'https:' || parts.username || parts.password || parts.port) return null;
  const host = parts.hostname, pathName = parts.pathname, search = parts.search, hash = parts.hash;
  const simple = !search && !hash;
  const user = simple && host === 'weibo.cn' && /^\/u\/[1-9][0-9]{4,19}$/.test(pathName);
  const legacyPost = simple && host === 'www.weibo.com' && /^\/detail\/[1-9][0-9]{4,19}$/.test(pathName);
  const service = simple && host === 'open.weibo.com' && pathName === '/cli/plan';
  const items = [...parts.searchParams.entries()];
  const names = items.map(([name]) => name);
  const validQuery = new Set(names).size === names.length && names.includes('rl') && items.every(([name, value]) =>
    (name === 'rl' && (value === '0' || value === '1')) ||
    (name === 'uid' && /^[1-9][0-9]{4,19}$/.test(value))
  );
  const post = host === 'weibo.cn' && /^\/comment\/[0-9A-Za-z]{1,12}$/.test(pathName) && validQuery && hash === '#cmtfrm';
  const webPostPath = /^\/(?:[1-9][0-9]{4,19}\/[0-9A-Za-z]{1,12}|detail\/[1-9][0-9]{4,19})$/.test(pathName);
  const webPost = host === 'weibo.com' && webPostPath && items.length === 1 && items[0][0] === 'from' && items[0][1] === 'feed' && hash === '#comment';
  if (!(user || legacyPost || service || post || webPost)) return null;
  return parts.href;
}

module.exports = { managementExternalURL };
