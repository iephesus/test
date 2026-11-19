'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUiEventQueue } = require('../desktop/win/ui-event-queue');

test('cold-start queue keeps library stub and control events until flush', () => {
  const queue = createUiEventQueue({ countLimit: 8, byteLimit: 64 * 1024 });
  assert.equal(queue.enqueue({ type: 'progress', phase: 'fetch' }), false);
  assert.equal(queue.enqueue({
    type: 'library',
    workspace: 'W1',
    version: '1.0.0',
    bootstrapId: 'b1',
    accounts: [{ uid: '1' }],
    database: [{ id: 'x' }]
  }), true);
  assert.equal(queue.enqueue({ type: 'error', message: 'boom', workspace: 'W1' }), true);
  assert.equal(queue.enqueue({ type: 'error', message: 'replaced', workspace: 'W1' }), true);
  assert.equal(queue.snapshot().length, 2);

  const flushed = queue.flush('W1');
  assert.equal(flushed.length, 2);
  assert.equal(flushed[0].type, 'library');
  assert.equal(flushed[0].partial, true);
  assert.deepEqual(flushed[0].accounts, []);
  assert.equal(flushed[0].workspace, 'W1');
  assert.equal(flushed[1].message, 'replaced');
  assert.equal(queue.snapshot().length, 0);
});

test('flush drops events bound to another workspace', () => {
  const queue = createUiEventQueue();
  queue.enqueue({ type: 'engineStopped', workspace: 'A', message: 'a' });
  queue.enqueue({ type: 'engineTransportError', workspace: 'B', message: 'b' });
  queue.enqueue({ type: 'quitting', message: 'all' });
  const events = queue.flush('A');
  assert.equal(events.length, 2);
  assert.equal(events[0].workspace, 'A');
  assert.equal(events[1].type, 'quitting');
});
