'use strict';
// Queue engine→UI events until the renderer posts `ready` (cold start / late attach).
const CONTROL_TYPES = new Set([
  'engineStopped', 'engineTransportError', 'quitting', 'refreshWarning', 'error', 'taskFutureError',
  'browserOpened', 'browserOpenFailed', 'feedbackPreview', 'feedbackResult', 'localError',
  'accountError', 'recoveryError'
]);

function createUiEventQueue(options = {}) {
  const eventLimit = options.eventLimit ?? 32 * 1024;
  const byteLimit = options.byteLimit ?? 128 * 1024;
  const countLimit = options.countLimit ?? 32;
  let queued = [];
  let queuedBytes = 0;

  function identity(key) {
    return ['type', 'workspace', 'requestId', 'taskId', 'scope'].map(k => key[k] || '').join('|');
  }

  function enqueue(original) {
    if (!original || typeof original !== 'object') return false;
    const type = original.type || '';
    let event = original;
    if (type === 'library') {
      event = { type: 'library', partial: true, accounts: [], favorites: [], postFavorites: [], reportKeep: 1 };
      for (const key of ['workspace', 'version', 'bootstrapId']) {
        if (typeof original[key] === 'string') event[key] = original[key];
      }
      if (original.homeBlocked === true) event.homeBlocked = true;
    } else if (!CONTROL_TYPES.has(type)) {
      return false;
    }
    let data;
    try { data = Buffer.from(JSON.stringify(event)); } catch { return false; }
    if (data.length > eventLimit) return false;
    const id = identity(event);
    queued = queued.filter(item => identity(item) !== id);
    queuedBytes = queued.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item)), 0);
    while (queued.length && (queued.length >= countLimit || queuedBytes + data.length > byteLimit)) {
      const removed = queued.shift();
      queuedBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    queued.push(event);
    queuedBytes += data.length;
    return true;
  }

  function flush(workspace) {
    const events = queued.filter(event => !event.workspace || event.workspace === workspace);
    queued = [];
    queuedBytes = 0;
    return events;
  }

  function snapshot() {
    return { length: queued.length, bytes: queuedBytes };
  }

  return { enqueue, flush, snapshot, CONTROL_TYPES };
}

module.exports = { createUiEventQueue, CONTROL_TYPES };
