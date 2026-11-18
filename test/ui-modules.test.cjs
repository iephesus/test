'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const labels = require('../desktop/ui/labels');
const relative = require('../desktop/ui/relative-time');
const history = require('../desktop/ui/history-view');

test('labels map engine kinds to desktop mode names', () => {
  assert.equal(labels.modeLabel('sent'), '发出的评论');
  assert.equal(labels.modeLabel('both'), '发出和收到的评论');
  assert.equal(labels.internal.received, 'comments-received');
  assert.equal(labels.policies.database, '用本地数据生成');
});

test('relativeTime formats nearby and unknown timestamps', () => {
  const now = Date.parse('2026-11-18T12:00:00+08:00');
  assert.equal(relative.relativeTime(now - 30 * 1000, now), '刚刚');
  assert.equal(relative.relativeTime(now - 10 * 60 * 1000, now), '10 分钟前');
  assert.equal(relative.relativeTime(now - 5 * 3600 * 1000, now), '5 小时前');
  assert.equal(relative.relativeTime('not-a-date', now), '时间未知');
});

test('ownsHistory requires matching workspace request identity', () => {
  const state = {
    view: 'history',
    workspace: 'A',
    historyRequest: { requestId: 'r1', workspace: 'A', target: '1', mode: 'comments-both', targetKind: 'user' }
  };
  assert.equal(history.ownsHistory(state, { requestId: 'r1', target: '1', mode: 'comments-both' }), true);
  assert.equal(history.ownsHistory(state, { requestId: 'r2', target: '1', mode: 'comments-both' }), false);
  assert.equal(history.ownsHistory({ ...state, view: 'create' }, { requestId: 'r1', target: '1', mode: 'comments-both' }), false);
  assert.equal(history.ownsHistory(state, { requestId: 'r1', target: '1', mode: 'comments-both', workspace: 'B' }, true), false);
});

test('collect-start quotes paid sync without unbound crypto.randomUUID', () => {
  const collect = require('../desktop/ui/collect-start');
  const sent = [];
  const toasts = [];
  const api = collect.create({
    getState: () => ({ engineAvailable: true, task: 'sync', busy: false, starting: false, workspace: 'W', accounts: [], category: 'users' }),
    send: message => sent.push(message),
    toast: text => toasts.push(text),
    validate: () => null,
    buildQuery: () => ({ syncOnly: true, policy: 'cache', mode: 'comments-both', limit: '2', target: '3833919181' }),
    beginLaunch: () => {},
    confirm: async () => false,
    field: () => ({ hidden: false, textContent: '', setAttribute() {}, focus() {}, scrollIntoView() {}, closest: () => null }),
    all: () => [],
    postId: id => id,
    userInfo: () => null
  });
  assert.doesNotThrow(() => api.start(false));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'pricingQuote');
  assert.match(sent[0].requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(toasts[0], '正在查询本次任务费用…');
});
