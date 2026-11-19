'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createForegroundQueue, needsForeground, FOREGROUND_ACTIONS } = require('../desktop/foreground-queue');

test('needsForeground covers core user-facing actions', () => {
  assert.equal(needsForeground({ action: 'run' }), true);
  assert.equal(needsForeground({ action: 'login' }), true);
  assert.equal(needsForeground({ action: 'manageBatch', operation: 'subscribe' }), true);
  assert.equal(needsForeground({ action: 'manageBatch', operation: 'delete' }), false);
  assert.equal(needsForeground({ action: 'account' }), false);
  assert.ok(FOREGROUND_ACTIONS.has('pricingQuote') === false);
});

test('foreground queue yields and drains one item when blockers clear', async () => {
  const published = [];
  let blockers = true;
  const handled = [];
  const queue = createForegroundQueue({
    getWorkspace: () => 'W',
    isBusyBlockers: () => blockers,
    isTerminating: () => false,
    interruptAutomatic: () => { published.push('interrupt'); },
    scopedPublish: base => (type, data) => published.push({ base, type, ...data }),
    dispatchQueued: async (message, token) => {
      handled.push({ message, token });
    },
    recordPreparation: () => {},
    resumeQuery: () => ({ mode: 'comments-both' })
  });

  assert.equal(queue.queueForeground({ action: 'run', requestId: 'r1', query: { mode: 'comments-both' } }), true);
  assert.equal(queue.hasQueued(), true);
  assert.equal(handled.length, 0);
  assert.ok(published.some(item => item === 'interrupt'));
  assert.ok(published.some(item => item.type === 'manualQueued'));

  blockers = false;
  queue.drainForeground();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled.length, 1);
  assert.equal(handled[0].message.action, 'run');
  assert.equal(handled[0].token, queue.queuedDispatch);
  assert.equal(queue.hasQueued(), false);
});
