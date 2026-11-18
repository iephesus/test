'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const quote = require('../desktop/pricing-quote');
const collect = require('../desktop/ui/collect-start');

test('quoteParts splits comments-both into by_me/other and to_me/other budgets', () => {
  const value = quote.quoteParts({ mode: 'comments-both', limit: '50' });
  assert.equal(value.mode, 'both');
  assert.deepEqual(value.parts.map(p => [p.kind, p.budget]), [['sent', 25], ['received', 25]]);
});

test('quoteParts keeps full-text user-posts as timeline + show_batch', () => {
  const value = quote.quoteParts({ mode: 'user-posts', limit: '20', fullText: true });
  assert.deepEqual(value.parts.map(p => p.kind), ['user-posts', 'post-details']);
});

test('quoteParts rejects missing limit unless unlimited', () => {
  assert.throws(() => quote.quoteParts({ mode: 'comments-sent', limit: '' }), /取数上限/);
  const all = quote.quoteParts({ mode: 'comments-sent', unlimited: true });
  assert.equal(all.count, Infinity);
});

test('quote uses injected prices and formats a once-per-task message', async () => {
  const prices = {
    'comments/by_me/other': { command: { group: 'comments', action: 'by_me/other', method: 'GET', price_type: 'per_record', pricing: { configured: true, unit_price: 3, currency: 'credits' } } }
  };
  const result = await quote.quote({ mode: 'comments-sent', limit: '10' }, {
    query: async ([, , group, action]) => prices[group + '/' + action]
  });
  assert.equal(result.estimateMax, 30);
  assert.equal(result.lines[0].unitPrice, 3);
  assert.match(result.message, /预估上限合计：约 30 credits/);
  assert.match(quote.formatMessage(result, 'UID 1'), /目标：UID 1/);
});

test('collect-start gates paid sync once and leaves preview/local alone', () => {
  assert.equal(collect.shouldConfirmPaidStart(false, { syncOnly: true, policy: 'cache' }), true);
  assert.equal(collect.shouldConfirmPaidStart(false, { syncOnly: true, policy: 'update' }), true);
  assert.equal(collect.shouldConfirmPaidStart(true, { syncOnly: true, policy: 'cache' }), false);
  assert.equal(collect.shouldConfirmPaidStart(false, { syncOnly: false, policy: 'database' }), false);
  assert.equal(collect.shouldConfirmPaidStart(false, { syncOnly: true, policy: 'database' }), false);
  assert.equal(collect.replaceTargetLabel('目标：当前对象\n内容：发出的评论', 'UID 9'), '目标：UID 9\n内容：发出的评论');
  assert.equal(collect.targetLabelForQuery({ mode: 'post-comments', target: 'p1' }, {
    category: 'post',
    postId: () => 'p1'
  }), '博文 p1');
});

test('collect-start create quotes before launch and cancels on mismatch', async () => {
  const sent = [];
  let launched = null;
  const state = { workspace: 'A', busy: false, starting: false, engineAvailable: true, task: 'sync', category: 'users', accounts: [{ uid: '1', nickname: '甲' }] };
  const form = { 'form-error': { hidden: true, textContent: '' } };
  const api = collect.create({
    getState: () => state,
    send: msg => sent.push(msg),
    toast() {},
    validate: () => null,
    buildQuery: () => ({ syncOnly: true, policy: 'cache', mode: 'comments-sent', limit: '5', uid: '1' }),
    beginLaunch: input => { launched = input; },
    currentUser: () => '1',
    currentTarget: () => '1',
    postId: v => v,
    userInfo: () => null,
    field: id => form[id] || { hidden: false, textContent: '', setAttribute() {}, focus() {}, scrollIntoView() {}, closest: () => null },
    all: () => [],
    confirm: async () => true,
    uuid: () => 'req-1'
  });
  api.start(false);
  assert.equal(sent[0].action, 'pricingQuote');
  assert.equal(launched, null);
  api.receive({ type: 'pricingQuote', requestId: 'req-1', message: '目标：当前对象\n确认后才会开始联网取数。' });
  await new Promise(r => setImmediate(r));
  assert.equal(launched.limit, '5');
});
