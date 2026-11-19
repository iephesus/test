'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../lib/report-catalog');

test('normalizeId rewrites Windows separators for report identity', () => {
  assert.equal(catalog.normalizeId('user-comments\\123\\a.html'), 'user-comments/123/a.html');
  assert.equal(catalog.normalizeId('user-comments/123/a.html'), 'user-comments/123/a.html');
  assert.equal(catalog.normalizeId(null), null);
});

test('entryOf finds catalog rows stored with either slash style', () => {
  const entries = {
    'user-comments/123/a.html': { uid: '123' },
    'posts\\9\\b.html': { uid: '9' }
  };
  assert.deepEqual(catalog.entryOf(entries, 'user-comments\\123\\a.html'), { uid: '123' });
  assert.deepEqual(catalog.entryOf(entries, 'posts/9/b.html'), { uid: '9' });
});
