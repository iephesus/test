'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const home = require('../desktop/ui/home-surface');

test('homeLoadEvent clears lists on workspace change and tracks section ready', () => {
  const state = {
    workspace: 'A',
    bootstrapId: 'old',
    homeBlocked: false,
    homeLoading: {
      users: { status: 'ready', snapshot: true },
      posts: { status: 'ready', snapshot: true },
      reports: { status: 'ready', snapshot: true },
      subscriptions: { status: 'ready', snapshot: true }
    },
    homeUsers: [{ uid: '1' }],
    posts: [{ postId: '2' }],
    postAuthors: { 1: {} },
    database: [1],
    reports: [1],
    homeAssetSnapshots: { x: 1 }
  };
  let snapshotsReset = 0;
  let historyReset = 0;
  const api = home.create({
    state,
    send: () => {},
    $: () => null,
    node: () => ({}),
    button: () => ({}),
    getHomeSnapshots: () => ({ reset: () => { snapshotsReset += 1; } }),
    getHistoryView: () => ({ reset: () => { historyReset += 1; } })
  });

  assert.equal(api.homeLoadEvent({
    type: 'library',
    workspace: 'B',
    bootstrapId: 'new',
    partial: true
  }, false), true);
  assert.equal(snapshotsReset, 1);
  assert.equal(historyReset, 1);
  assert.equal(state.homeUsers.length, 0);
  assert.equal(state.homeLoading.users.status, 'loading');
  assert.equal(api.homeLoadEvent({ type: 'homeUsers', bootstrapId: 'new' }, false), true);
  assert.deepEqual(state.homeLoading.users, { status: 'ready', snapshot: true });
});

test('syncOwnerUnread projects unread onto home rows', () => {
  const state = {
    homeUsers: [{ uid: '12345', unread: 0 }],
    posts: [],
    subscriptions: []
  };
  const api = home.create({
    state,
    send: () => {},
    $: () => null,
    node: () => ({}),
    button: () => ({}),
    getHomeSnapshots: () => null,
    getHistoryView: () => null
  });
  const changed = api.syncOwnerUnread({
    type: 'homeUsers',
    readingRevision: 2,
    users: [{ uid: '12345', unread: 4, unreadUnavailable: false }]
  });
  assert.ok(changed.has('user:12345'));
  assert.equal(state.homeUsers[0].unread, 4);
});
