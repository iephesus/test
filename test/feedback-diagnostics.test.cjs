'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FeedbackDiagnostics } = require('../desktop/win/feedback-diagnostics');

test('feedback snapshot includes projected timeline without raw paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-feedback-'));
  const feedback = new FeedbackDiagnostics({ version: '1.0.0', build: '2025' });
  feedback.enablePersistence(dir);
  feedback.observe({ type: 'appStarted' });
  feedback.capture({
    action: 'run',
    requestId: 'req-1',
    workspace: 'C:\\Users\\example\\AppData\\selnokk.weibo.reader',
    query: { mode: 'comments-both', target: '1234567890' }
  });
  feedback.observe({
    type: 'started',
    requestId: 'req-1',
    taskId: 'task-1',
    workspace: 'C:\\Users\\example\\AppData\\selnokk.weibo.reader',
    query: { mode: 'comments-both', target: '1234567890' }
  });
  feedback.observe({
    type: 'finished',
    requestId: 'req-1',
    taskId: 'task-1',
    code: 0,
    records: 12,
    addedRecords: 3
  });
  feedback.observe({ type: 'transportFailed' });

  const snap = feedback.makeSnapshot('1.0.0', '2025');
  assert.ok(snap.bytes.length > 0);
  assert.match(snap.text, /Weibo Reader 问题反馈/);
  assert.match(snap.text, /错误码：TRANSPORT_FAILED/);
  assert.equal(snap.summary.writeFailed, false);
  assert.ok(snap.summary.rows >= 3);

  const body = snap.bytes.toString('utf8');
  assert.doesNotMatch(body, /C:\\Users\\example/);
  assert.doesNotMatch(body, /1234567890/);
  assert.match(body, /"format":"weibo-reader-runtime-log"/);
  assert.match(body, /request:[a-f0-9]{24}/);
  assert.match(body, /"code":"TRANSPORT_FAILED"/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('feedback copy contract uses cached preview text fields', () => {
  const feedback = new FeedbackDiagnostics({ version: '1.0.0', build: '9' });
  feedback.observe({ type: 'appStarted' });
  feedback.observe({ type: 'engineStopped' });
  const snap = feedback.makeSnapshot('1.0.0', '9');
  assert.match(snap.text, /ENGINE_STOPPED/);
  assert.equal(typeof snap.summary.rows, 'number');
  assert.ok(Object.hasOwn(snap.summary, 'retentionDays'));
});
