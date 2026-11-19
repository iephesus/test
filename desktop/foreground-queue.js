'use strict';
// Foreground action queue: yield automatic work so user-facing ops run serially.
const crypto = require('node:crypto');

const FOREGROUND_ACTIONS = new Set([
  'workspace', 'userDeletePlan', 'userDeleteConfirm', 'manageDeletePlan', 'manageDeleteConfirm',
  'profilesRefresh', 'userProfileRetry', 'postAuthorAvatar', 'userAdd', 'run', 'resumeTask',
  'cleanup', 'merge', 'login', 'recoveryRetry', 'taskGapIgnore', 'taskFuturePreview',
  'taskFutureChoose', 'exchangeExport', 'exchangeInspect', 'exchangeCommit'
]);

function needsForeground(message) {
  if (!message || typeof message !== 'object') return false;
  if (FOREGROUND_ACTIONS.has(message.action)) return true;
  return message.action === 'manageBatch' && message.operation === 'subscribe';
}

function createForegroundQueue(deps) {
  const {
    getWorkspace,
    isBusyBlockers,
    interruptAutomatic,
    scopedPublish,
    dispatchQueued,
    recordPreparation,
    resumeQuery
  } = deps;
  let manualQueue = null;
  let foregroundDispatching = false;
  const queuedRequests = new Map();
  const queuedDispatch = Symbol('queued foreground');

  function pendingForeground() {
    return !!manualQueue && !foregroundDispatching;
  }

  function queueForeground(message) {
    if (deps.isTerminating?.()) throw Error('正在保存并退出，未安排新的操作');
    const workspace = getWorkspace();
    const captured = structuredClone({
      ...message,
      workspace: typeof message.workspace === 'string' ? message.workspace : workspace
    });
    const requestId = captured.requestId || crypto.randomUUID();
    captured.requestId = requestId;
    if (typeof requestId !== 'string' || requestId.length > 256) throw Error('排队请求身份无效');
    const signature = crypto.createHash('sha256').update(JSON.stringify(captured)).digest('hex');
    const previous = queuedRequests.get(requestId);
    if (previous) {
      if (previous.signature !== signature) throw Error('排队请求身份与原操作不一致');
      return !previous.completed;
    }
    if (captured.action === 'resumeTask') {
      captured.query = resumeQuery(captured);
    }
    const bytes = Buffer.byteLength(JSON.stringify(captured));
    if ((manualQueue?.length || 0) >= 16 || (manualQueue || []).reduce((n, q) => n + q.bytes, 0) + bytes > 4 * 1024 * 1024) {
      throw Error('前台操作队列已满，请先完成或取消已有操作');
    }
    const item = { id: crypto.randomUUID(), requestId, message: captured, signature, bytes };
    (manualQueue ??= []).push(item);
    queuedRequests.set(requestId, item);
    interruptAutomatic?.(item);
    scopedPublish(captured.workspace)(
      ['run', 'resumeTask'].includes(captured.action) ? 'manualQueued' : 'foregroundQueued',
      {
        id: item.id,
        requestId,
        action: captured.action,
        ...(captured.query ? { query: captured.query } : {}),
        message: '正在等待后台响应保存，完成后自动执行。'
      }
    );
    drainForeground();
    return true;
  }

  function drainForeground() {
    if (!manualQueue || foregroundDispatching || isBusyBlockers()) return;
    const item = manualQueue.shift();
    if (!manualQueue.length) manualQueue = null;
    foregroundDispatching = true;
    Promise.resolve(dispatchQueued(item.message, queuedDispatch)).finally(() => {
      foregroundDispatching = false;
      queuedRequests.set(item.requestId, { signature: item.signature, completed: true });
      scopedPublish(item.message.workspace)('foregroundDequeued', {
        id: item.id,
        requestId: item.requestId,
        action: item.message.action
      });
      while (queuedRequests.size > 512) {
        const old = [...queuedRequests].find(([, value]) => value.completed);
        if (!old) break;
        queuedRequests.delete(old[0]);
      }
      drainForeground();
    });
  }

  function cancelForeground(requestId, all = false) {
    if (!manualQueue) return false;
    const selected = all
      ? manualQueue
      : requestId
        ? manualQueue.filter(item => item.requestId === requestId)
        : manualQueue.slice(0, 1);
    if (!selected.length) return false;
    manualQueue = manualQueue.filter(item => !selected.includes(item));
    if (!manualQueue.length) manualQueue = null;
    for (const item of selected) {
      queuedRequests.set(item.requestId, { signature: item.signature, completed: true });
      scopedPublish(item.message.workspace)('foregroundDequeued', {
        id: item.id,
        requestId: item.requestId,
        action: item.message.action,
        cancelled: true
      });
      scopedPublish(item.message.workspace)('localWriteState', { requestId: item.requestId, busy: false });
      if (['run', 'resumeTask'].includes(item.message.action)) {
        recordPreparation({
          id: item.id,
          requestId: item.requestId,
          query: item.message.query,
          startedAt: new Date().toISOString()
        }, '前台排队期间取消，尚未取数');
        scopedPublish(item.message.workspace)('finished', {
          id: item.id,
          taskId: item.id,
          requestId: item.requestId,
          kind: 'collect',
          code: null,
          cancelled: true,
          preparation: true,
          reports: []
        });
      }
    }
    drainForeground();
    return true;
  }

  return {
    needsForeground,
    pendingForeground,
    queueForeground,
    drainForeground,
    cancelForeground,
    queuedRequests,
    queuedDispatch,
    hasQueued: () => !!manualQueue,
    isDispatching: () => foregroundDispatching
  };
}

module.exports = { createForegroundQueue, needsForeground, FOREGROUND_ACTIONS };
