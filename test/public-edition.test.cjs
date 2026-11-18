'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {buildArguments, runBridge} = require('../desktop/bridge');
const {createAutoFollow, validate} = require('../desktop/auto-follow');
const ledger = require('../lib/auto-follow-budget');
const evidence = require('../lib/legacy-web-evidence');
const reading = require('../lib/post-reading-state');
const {postShortId} = require('../lib/post-links');
const {atomic} = require('../lib/durable-write');

const postId = '90071992547409931';
const uid = '1000000001';

function isolated(t) {
 const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-public-test-'));
 t.after(() => fs.rmSync(base, {recursive: true, force: true}));
 fs.mkdirSync(path.join(base, 'data'), {recursive: true});
 fs.writeFileSync(path.join(base, 'data/.layout-v2'), '2');
 return base;
}

test('removed acquisition channels reject a request without launching a service', async t => {
 const base = isolated(t);
 const events = [];
 const bridge = runBridge({
  workspace: base, deferBootstrap: true, send: event => events.push(event),
  spawn: () => assert.fail('unexpected service process')
 });
 const query = {target: postId, mode: 'post-comments', task: 'sync', syncOnly: true, policy: 'cache', limit: '10'};
 assert.ok(buildArguments({...query, source: 'cli'}).includes('post-comments'));
 assert.throws(() => buildArguments({...query, source: 'crawler'}), /数据来源无效/);
 await bridge.handle({action: 'crawlerRank', workspace: base, requestId: 'removed'});
 await bridge.handle({action: 'run', workspace: base, requestId: 'invalid', query: {...query, source: 'crawler'}});
 assert.deepEqual(events.filter(e => e.type === 'error').map(e => e.requestId), ['removed', 'invalid']);
 assert.equal(events.some(e => e.type === 'started'), false);
});

test('unsupported historical subscriptions are preserved and do not dispatch', t => {
 const base = isolated(t);
 const now = Date.parse('2026-01-01T00:00:00Z');
 const old = {uid: postId, postId, targetKind: 'post', source: 'crawler', enabled: true, mode: 'post-comments', interval: 15, roundLimit: 100, dailyBudget: 100, nextCheckAt: new Date(now - 1000).toISOString()};
 const settingsFile = path.join(ledger.directory(base), 'settings.json');
 ledger.atomic(settingsFile, {schema: 1, entries: [old]});
 const service = createAutoFollow(base, {now: () => now, launch: () => assert.fail('unexpected check'), setTimer: () => null});
 t.after(() => {service.close();service.release();});
 assert.throws(() => validate(old), /订阅数据来源无效/);
 service.tick();
 assert.deepEqual(service.snapshot().entries, []);
 service.save({uid, mode: 'sent', interval: 15, roundLimit: 10, dailyBudget: 100, enabled: false});
 assert.equal(service.snapshot().entries[0].uid, uid);
 assert.deepEqual(ledger.read(settingsFile).entries.find(e => e.uid === postId), old);
 assert.deepEqual(ledger.rounds(base), []);
});

test('saved web receipts still recover exact unread IDs from local evidence', t => {
 const base = isolated(t);
 const dir = path.join(base, 'data/post-comments', postId);
 reading.start(base, postId);
 const scope = '00000000-0000-4000-a000-000000000001';
 const request = {
  id: '00000000-0000-4000-a000-000000000002', scope, status: 200,
  purpose: 'comments:00000000-0000-4000-a000-000000000003',
  url: 'https://weibo.cn/comment/' + postShortId(postId) + '?rl=0',
  receivedAt: '2026-01-01T00:00:00.000Z', rawHash: 'a'.repeat(64)
 };
 const id = '90071992547409932';
 const rows = require('../lib/post-comments').postPageRows({
  comments: [{idstr: id, text: '离线公开版测试正文', created_at: '2026-01-01T00:00:00.000Z', user: {idstr: uid}, status: {idstr: postId}}]
 }, postId).rows;
 const store = evidence.open(dir, {scope, kind: 'post', id: postId});
 const receipt = path.join(store.folder, request.id + '.json');
 const hash = atomic(receipt, {schema: 1, request, parsed: {postId, rows, firstIndependentIds: [id]}});
 assert.equal(reading.recover(base, postId).items[id].firstSeenAt, request.receivedAt);
 assert.equal(store.receipt({id: request.id, hash}).hash, hash);
 assert.equal(reading.markRead(base, postId, [id]).changed, 1);
 assert.equal(reading.recover(base, postId).items[id].readAt != null, true);
 assert.equal(store.receipt({id: request.id, hash}).hash, hash);
});
