'use strict';
// Windows projection of FeedbackDiagnostics.swift — structured runtime timeline only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const EXTRA_EVENTS = new Set([
  'request', 'appStarted', 'startupListReady', 'appExiting', 'quitRequested', 'library', 'localData',
  'preparing', 'manualQueued', 'stopping', 'progress', 'source', 'phase', 'accountLoading', 'account',
  'credits', 'localWriteState', 'recoveryFinished', 'exchangeProgress', 'userProfile',
  'taskFuturePreview', 'taskFutureCandidates', 'taskFutureChosen', 'taskFutureError', 'autoFrequency'
]);
const STORED_EVENTS = new Set([
  ...EXTRA_EVENTS,
  'started', 'finished', 'summary', 'collection', 'autoSafety', 'error', 'localError', 'insightsError',
  'exchangeError', 'localExported', 'searchOpened', 'engineStopped', 'transportFailed', 'engineStartFailed',
  'browserOpenFailed', 'reportReadFailed', 'refreshWarning', 'accountError', 'followError', 'manageError',
  'userNoteError', 'postNoteError', 'userDeleteError', 'postDeleteError', 'localInventoryError',
  'pricingError', 'profileError', 'recoveryError'
]);
const OPERATIONS = new Set([
  'none', 'post-comments', 'comments-sent', 'comments-received', 'comments-both', 'user-posts',
  'localExport', 'searchOpen', 'globalSearch', 'coverageTimeline', 'localData', 'localInventory',
  'exchange', 'account', 'rank', 'subscription', 'note', 'management', 'profile', 'recovery', 'pricing'
]);
const CODES = new Set([
  'AUTO_BASELINE', 'AUTO_SINCE_IGNORED', 'AUTO_BODY_MISSING', 'AUTO_OUTCOME_UNKNOWN', 'AUTO_LEDGER_INVALID',
  'AUTO_FINALIZATION', 'AUTO_SETTINGS_SAVE', 'AUTO_START_FAILED', 'AUTO_SETTLEMENT', 'AUTO_INTERRUPTED',
  'AUTO_STATE_RECOVERY', 'AUTO_RETRY', 'AUTO_WORKER_BINDING', 'AUTO_BALANCE_UNKNOWN', 'AUTO_PRICE_UNKNOWN',
  'AUTO_UNSUPPORTED', 'AUTO_DAILY_BUDGET', 'AUTO_BALANCE', 'AUTO_ROUND_LIMIT', 'AUTO_REQUEST_FAILED',
  'AUTO_RESPONSE_INVALID', 'AUTO_REQUEST_RECORD', 'AUTO_IN_FLIGHT', 'AUTO_BOUNDARY', 'IP_GEO_DENIED',
  'CLI_ACCOUNT_QUERY_FAILED', 'CLI_ACCOUNT_JSON', 'CLI_ACCOUNT_SCHEMA', 'CLI_ACCOUNT_BALANCE_MISSING',
  'CLI_ACCOUNT_BALANCE_INVALID', 'NONE', 'UNKNOWN', 'ENGINE_START_FAILED', 'ENGINE_STOPPED',
  'TRANSPORT_FAILED', 'BROWSER_OPEN_FAILED', 'USER_CANCELLED', 'AUTO_YIELD', 'LOCAL_SNAPSHOT_BUSY',
  'LOCAL_SNAPSHOT_STALE', 'LOCAL_SEARCH_LIMIT', 'ERR_WORKER_OUT_OF_MEMORY', 'LOCAL_SETTINGS_INVALID',
  'LOCAL_SOURCE_INVALID', 'DATA_LOCK_BUSY', 'EXCHANGE_INTERRUPTED', 'REQUEST_EVIDENCE_INVALID',
  'RESUME_EVIDENCE_INVALID', 'POST_READING_EVIDENCE_CHANGED', 'RECORD_ID_UNRELIABLE',
  'LOCAL_PROFILE_SOURCE_INVALID', 'EIO', 'ENOSPC', 'EACCES', 'EPERM'
]);
const PHASES = new Set([
  'none', 'pending', 'prepare', 'preparing', 'running', 'collect', 'fetch', 'save', 'saving', 'saved',
  'recover', 'recovery', 'finalize', 'finalizing', 'finished', 'cancelled', 'failed', 'waiting',
  'checking', 'cancelling', 'identity', 'account', 'balance', 'query', 'parse', 'persist', 'request',
  'response', 'account-initial', 'account-final', 'startup-list'
]);
const DIRECTION_KINDS = new Set(['sent', 'received', 'post-comments', 'user-posts', 'mentions-comments', 'mentions-posts']);
const MEMORY_LIMIT = 128;
const PREVIEW_BYTES = 24 * 1024;
const SEGMENT_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 20 * 1024 * 1024;
const RETENTION_MS = 7 * 86400 * 1000;

function isoNow(date = new Date()) {
  return date.toISOString();
}

function count(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000_000) return null;
  if (!Number.isInteger(value) && Math.floor(value) !== value) return null;
  return Math.trunc(value);
}

function displayStamp(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

class FeedbackDiagnostics {
  constructor(options = {}) {
    this.events = [];
    this.source = 'local';
    this.operation = 'none';
    this.lastCode = 'NONE';
    this.fault = null;
    this.sequence = 0;
    this.contexts = new Map();
    this.capturedRequests = new Set();
    this.progressAt = new Map();
    this.starts = new Map();
    this.startupAt = null;
    this.coalesced = 0;
    this.session = crypto.randomUUID();
    this.anonymousKey = crypto.randomBytes(32);
    this.directory = null;
    this.storageFailed = false;
    this.dropped = 0;
    this.rotated = 0;
    this.invalidRows = 0;
    this.writeFailures = 0;
    this.segmentBytes = 0;
    this.appVersion = options.version || 'unknown';
    this.build = options.build || 'unknown';
  }

  enablePersistence(directory) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      this.directory = directory;
      const keyPath = path.join(directory, 'identity.key');
      if (fs.existsSync(keyPath)) {
        const key = fs.readFileSync(keyPath);
        if (key.length === 32) this.anonymousKey = key;
        else fs.writeFileSync(keyPath, this.anonymousKey);
      } else {
        fs.writeFileSync(keyPath, this.anonymousKey);
      }
      const statusPath = path.join(directory, 'status.json');
      if (fs.existsSync(statusPath)) {
        try {
          const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          this.writeFailures = Number(status.writeFailures) || 0;
          this.dropped = Number(status.dropped) || 0;
          this.rotated = Number(status.rotated) || 0;
          this.invalidRows = Number(status.invalid) || 0;
        } catch { /* ignore corrupt status */ }
      }
      this.#prune();
      const current = path.join(directory, 'current.jsonl');
      if (fs.existsSync(current)) this.segmentBytes = fs.statSync(current).size;
    } catch {
      this.storageFailed = true;
      this.directory = null;
    }
  }

  finishSession() {
    this.observe({ type: 'appExiting' });
    this.#flushStatus();
  }

  capture(value) {
    if (!value || typeof value !== 'object') return;
    const action = value.action;
    if (typeof action !== 'string' || Buffer.byteLength(action) > 64) return;
    const query = value.query && typeof value.query === 'object' ? value.query : {};
    let origin = 'local';
    let op = 'none';
    if (action === 'run') {
      origin = 'cli';
      const mode = query.mode || 'none';
      op = query.operation === 'account' ? 'account'
        : query.operation === 'rank' ? 'rank'
          : OPERATIONS.has(mode) ? mode : 'none';
    } else if (['localExport', 'localData', 'localInventory', 'globalSearch', 'searchOpen', 'coverageTimeline'].includes(action)) {
      op = action;
    } else if (String(action).startsWith('exchange')) {
      op = 'exchange';
    } else if (['account', 'login', 'loginCancel'].includes(action)) {
      origin = 'cli';
      op = 'account';
    } else if (String(action).startsWith('follow')) {
      op = 'subscription';
    } else if (['userNoteSave', 'postNoteSave'].includes(action)) {
      op = 'note';
    } else if (String(action).startsWith('manage') || String(action).startsWith('userDelete') || String(action).startsWith('postDelete')) {
      op = 'management';
    } else if (action === 'profilesRefresh' || action === 'userProfileRetry') {
      origin = 'cli';
      op = 'profile';
    } else if (['recoveryRetry', 'taskGapIgnore', 'taskFuturePreview', 'taskFutureChoose'].includes(action)) {
      op = 'recovery';
    } else if (action === 'pricing' || action === 'pricingQuote') {
      origin = 'cli';
      op = 'pricing';
    } else {
      return;
    }
    const requestKey = this.#contextKey(value.requestId);
    if (requestKey && this.contexts.has(requestKey) && ['stop', 'loginCancel'].includes(action)) {
      const old = this.contexts.get(requestKey);
      origin = old[0];
      op = old[1];
    }
    this.source = origin;
    this.operation = op;
    if (requestKey) {
      this.contexts.set(requestKey, [origin, op]);
      if (this.contexts.size > 256) this.contexts.delete(this.contexts.keys().next().value);
      const dedupe = requestKey + '|' + action;
      if (this.capturedRequests.has(dedupe)) return;
      this.capturedRequests.add(dedupe);
      if (this.capturedRequests.size > 512) {
        this.capturedRequests.clear();
        this.capturedRequests.add(dedupe);
      }
      this.starts.set(requestKey, Date.now());
      if (this.starts.size > 256) this.starts.delete(this.starts.keys().next().value);
    }
    this.sequence += 1;
    const item = {
      sequence: this.sequence,
      session: this.session,
      at: isoNow(),
      event: 'request',
      source: origin,
      operation: op,
      code: 'NONE'
    };
    this.#correlations(value, item);
    this.#append(item);
  }

  observe(value) {
    if (!value || typeof value !== 'object') return;
    const type = value.type;
    if (typeof type !== 'string' || !STORED_EVENTS.has(type)) return;

    if (type === 'started' && value.query && typeof value.query === 'object') {
      this.capture({ action: 'run', requestId: value.requestId || value.taskId || '', query: value.query });
    }

    const id = this.#contextKey(value.requestId || value.taskId);
    let [eventSource, eventOperation] = this.contexts.get(id) || (id ? ['local', 'none'] : [this.source, this.operation]);
    const routes = {
      accountError: ['cli', 'account'],
      userProfile: ['cli', 'profile'],
      userNoteError: ['local', 'note'],
      postNoteError: ['local', 'note'],
      manageError: ['local', 'management'],
      userDeleteError: ['local', 'management'],
      postDeleteError: ['local', 'management'],
      followError: ['local', 'subscription'],
      localInventoryError: ['local', 'localInventory'],
      pricingError: ['cli', 'pricing'],
      profileError: ['cli', 'profile'],
      recoveryError: ['local', 'recovery']
    };
    if (!this.contexts.has(id) && routes[type]) {
      eventSource = routes[type][0];
      eventOperation = routes[type][1];
    }
    if (type === 'refreshWarning') {
      eventSource = 'local';
      eventOperation = 'recovery';
    }
    if (type === 'localExported' || type === 'searchOpened') {
      eventSource = 'local';
      eventOperation = type === 'searchOpened' ? 'searchOpen' : 'localExport';
    }
    if (type === 'localData') {
      eventSource = 'local';
      eventOperation = 'localData';
    }

    const nativeCodes = {
      engineStopped: 'ENGINE_STOPPED',
      transportFailed: 'TRANSPORT_FAILED',
      engineStartFailed: 'ENGINE_START_FAILED',
      browserOpenFailed: 'BROWSER_OPEN_FAILED'
    };
    let ownCode = 'NONE';
    if (nativeCodes[type]) ownCode = nativeCodes[type];
    else if (typeof value.code === 'string') ownCode = CODES.has(value.code) ? value.code : 'UNKNOWN';
    else if (type.endsWith('Error') || ['error', 'autoSafety', 'reportReadFailed', 'refreshWarning'].includes(type)
      || (type === 'userProfile' && value.profileStatus === 'error')) ownCode = 'UNKNOWN';
    else if (type === 'finished' && typeof value.code === 'number' && value.code !== 0) ownCode = 'UNKNOWN';

    if (type === 'progress' || type === 'collection') {
      const phase = typeof value.phase === 'string' ? value.phase : 'none';
      const state = typeof value.accountCheckState === 'string' ? value.accountCheckState : 'none';
      const kind = typeof value.kind === 'string' ? value.kind : 'none';
      const key = [id, type,
        DIRECTION_KINDS.has(kind) ? kind : 'none',
        PHASES.has(phase) ? phase : 'none',
        ['waiting', 'checking', 'cancelling'].includes(state) ? state : 'none'
      ].join(':');
      const last = this.progressAt.get(key);
      if (last && Date.now() - last < 2000) {
        this.coalesced += 1;
        return;
      }
      this.progressAt.set(key, Date.now());
      if (this.progressAt.size > 256) this.progressAt.clear();
    }

    if (ownCode !== 'NONE') {
      this.lastCode = ownCode;
      this.fault = [ownCode, eventSource, eventOperation];
    }
    this.source = eventSource;
    this.operation = eventOperation;
    this.sequence += 1;
    const item = {
      sequence: this.sequence,
      session: this.session,
      at: isoNow(),
      event: type,
      source: eventSource,
      operation: eventOperation,
      code: ownCode
    };
    for (const key of ['records', 'addedRecords', 'newRecords']) {
      const n = count(value[key]);
      if (n != null) item[key] = n;
    }
    if (typeof value.incomplete === 'boolean') item.incomplete = value.incomplete;
    this.#correlations(value, item);
    if (typeof value.phase === 'string' && value.phase.length <= 100 && PHASES.has(value.phase)) item.phase = value.phase;
    if (typeof value.kind === 'string' && DIRECTION_KINDS.has(value.kind)) item.kind = value.kind;
    const fetched = count(value.fetched);
    if (fetched != null) item.fetchedRecords = fetched;
    if (type === 'appStarted') this.startupAt = Date.now();
    if (type === 'startupListReady') {
      if (!this.startupAt) return;
      item.phase = 'startup-list';
      item.durationMs = Math.max(0, Math.min(604800000, Date.now() - this.startupAt));
      this.startupAt = null;
    }
    if (['finished', 'localData', 'localExported', 'localError'].includes(type) && id && this.starts.has(id)) {
      item.durationMs = Math.max(0, Math.min(604800000, Date.now() - this.starts.get(id)));
      this.starts.delete(id);
    }
    this.#append(item);
  }

  makeSnapshot(version = this.appVersion, build = this.build) {
    const rows = [];
    let diskBytes = 0;
    let startedAt = '';
    let endedAt = '';
    if (this.directory) {
      try {
        this.#prune();
        const files = fs.readdirSync(this.directory)
          .filter(name => name.endsWith('.jsonl'))
          .sort();
        for (const name of files) {
          const text = fs.readFileSync(path.join(this.directory, name), 'utf8');
          diskBytes += Buffer.byteLength(text);
          for (const line of text.split(/\n+/)) {
            if (!line) continue;
            const safe = this.#projectStored(JSON.parse(line));
            if (!safe) {
              this.invalidRows += 1;
              continue;
            }
            rows.push(safe);
            if (!startedAt) startedAt = safe.at;
            endedAt = safe.at;
          }
        }
      } catch {
        this.storageFailed = true;
      }
    }
    if (!rows.length) {
      for (const row of this.events) {
        const safe = this.#projectStored(row);
        if (!safe) continue;
        rows.push(safe);
        if (!startedAt) startedAt = safe.at;
        endedAt = safe.at;
      }
      diskBytes = Buffer.byteLength(rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    }

    const summary = {
      rows: rows.length,
      bytes: diskBytes,
      startedAt,
      endedAt,
      dropped: this.dropped,
      rotated: this.rotated,
      invalidRows: this.invalidRows,
      writeFailed: this.storageFailed || this.writeFailures > 0,
      retentionDays: 7,
      maxBytes: TOTAL_LIMIT,
      coalescedProgress: this.coalesced
    };

    const validVersion = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.]{1,20})?$/.test(version) ? version : 'unknown';
    const validBuild = /^\d{1,8}$/.test(String(build)) ? String(build) : 'unknown';
    const latest = this.fault || [this.lastCode, this.source, this.operation];
    const generatedAt = new Date();
    const metadata = {
      appVersion: validVersion,
      build: validBuild,
      system: `Windows ${os.release()}`,
      architecture: process.arch,
      generatedAt: isoNow(generatedAt),
      session: this.session,
      source: latest[1],
      operation: latest[2],
      errorCode: latest[0]
    };
    const header = JSON.stringify({
      format: 'weibo-reader-runtime-log',
      schema: 1,
      metadata,
      retention: summary
    });
    const body = rows.map(row => JSON.stringify(row)).join('\n');
    const bytes = Buffer.from(header + '\n' + (body ? body + '\n' : ''), 'utf8');
    const first = displayStamp(summary.startedAt);
    const last = displayStamp(summary.endedAt);
    const range = first && last ? `${first} — ${last}` : '暂无时间记录';
    const text = [
      'Weibo Reader 问题反馈',
      `当前导出版本：${validVersion}（build ${validBuild}）`,
      `系统：Windows ${os.release()} / ${process.arch}`,
      `生成时间：${displayStamp(isoNow(generatedAt)) || isoNow(generatedAt)}`,
      `来源：${latest[1]}`,
      `操作：${latest[2]}`,
      `错误码：${latest[0]}`,
      `运行日志：${summary.rows} 条，保留区间 ${range}`,
      '',
      '复现步骤：',
      '1. ',
      '',
      '预期表现：',
      '',
      '实际表现：',
      '',
      '运行日志只包含安全结构化时间线，不含正文、昵称、原始输出或个人路径；请由你选择发送。'
    ].join('\n');
    return { bytes, text, summary };
  }

  #anonymous(kind, value) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096) return null;
    const digest = crypto.createHmac('sha256', this.anonymousKey)
      .update(kind + ':' + value)
      .digest('hex')
      .slice(0, 24);
    return kind + ':' + digest;
  }

  #contextKey(value) {
    return this.#anonymous('request', value) || '';
  }

  #correlations(value, item) {
    for (const [field, kind] of [['requestId', 'request'], ['taskId', 'task'], ['workspace', 'workspace'], ['scope', 'credential']]) {
      const id = this.#anonymous(kind, value[field]);
      if (id) item[kind] = id;
    }
    const q = value.query && typeof value.query === 'object' ? value.query : value;
    const mode = q.mode || '';
    const kind = mode === 'post-comments' || q.postId != null ? 'post' : 'user';
    const target = q.target || q.postId || q.uid;
    if (typeof target === 'string' && /^[1-9][0-9]{4,19}$/.test(target)) {
      const object = this.#anonymous(kind, target);
      if (object) item.object = object;
    }
  }

  #append(original) {
    const row = {
      ...original,
      appVersion: this.appVersion,
      build: this.build
    };
    const safe = this.#projectStored(row);
    if (!safe) return;
    this.events.push(safe);
    if (this.events.length > MEMORY_LIMIT) this.events.splice(0, this.events.length - MEMORY_LIMIT);
    if (!this.directory) return;
    try {
      const line = JSON.stringify(safe) + '\n';
      const current = path.join(this.directory, 'current.jsonl');
      if (this.segmentBytes + Buffer.byteLength(line) > SEGMENT_LIMIT) this.#rotate();
      fs.appendFileSync(current, line);
      this.segmentBytes += Buffer.byteLength(line);
      if (safe.code !== 'NONE' || ['appExiting', 'quitRequested'].includes(safe.event)) this.#flushStatus();
    } catch {
      this.writeFailures += 1;
      this.storageFailed = true;
    }
  }

  #projectStored(row) {
    if (!row || typeof row !== 'object') return null;
    const type = row.event;
    const at = row.at;
    if (typeof type !== 'string' || !STORED_EVENTS.has(type)) return null;
    if (typeof at !== 'string' || !/^[0-9TZ:.+-]{20,35}$/.test(at) || Number.isNaN(Date.parse(at))) return null;
    const out = { event: type, at };
    if (typeof row.appVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.]{1,20})?$/.test(row.appVersion)) {
      out.appVersion = row.appVersion;
    }
    if (typeof row.build === 'string' && /^\d{1,8}$/.test(row.build)) out.build = row.build;
    for (const key of ['request', 'task', 'workspace', 'credential', 'object']) {
      const prefix = key === 'object' ? '(?:user|post)' : key;
      if (typeof row[key] === 'string' && new RegExp('^' + prefix + ':[a-f0-9]{24}$').test(row[key])) out[key] = row[key];
    }
    if (typeof row.session === 'string' && /^[0-9a-f-]{36}$/i.test(row.session)) out.session = row.session;
    for (const key of ['sequence', 'records', 'addedRecords', 'newRecords', 'fetchedRecords', 'returnedRecords',
      'reusedRecords', 'durationMs', 'waitUntil', 'retryAt', 'status', 'httpStatus', 'page', 'attempts']) {
      const n = count(row[key]);
      if (n != null) out[key] = n;
    }
    for (const key of ['incomplete', 'cancelled', 'coreSaved', 'automatic', 'verified']) {
      if (typeof row[key] === 'boolean') out[key] = row[key];
    }
    if (typeof row.source === 'string' && ['local', 'cli'].includes(row.source)) out.source = row.source;
    if (typeof row.operation === 'string' && OPERATIONS.has(row.operation)) out.operation = row.operation;
    if (typeof row.code === 'string' && CODES.has(row.code)) out.code = row.code;
    if (typeof row.phase === 'string' && PHASES.has(row.phase)) out.phase = row.phase;
    if (typeof row.kind === 'string' && DIRECTION_KINDS.has(row.kind)) out.kind = row.kind;
    return out;
  }

  #rotate() {
    if (!this.directory) return;
    const current = path.join(this.directory, 'current.jsonl');
    if (!fs.existsSync(current)) {
      this.segmentBytes = 0;
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(current, path.join(this.directory, `segment-${stamp}.jsonl`));
    this.rotated += 1;
    this.segmentBytes = 0;
    this.#prune();
  }

  #prune() {
    if (!this.directory) return;
    const files = fs.readdirSync(this.directory)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => {
        const full = path.join(this.directory, name);
        const st = fs.statSync(full);
        return { name, full, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    const cutoff = Date.now() - RETENTION_MS;
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const file of files) {
      if (file.name === 'current.jsonl') continue;
      if (file.mtime >= cutoff && total <= TOTAL_LIMIT) break;
      try {
        fs.unlinkSync(file.full);
        total -= file.size;
        this.dropped += 1;
      } catch { /* ignore */ }
    }
  }

  #flushStatus() {
    if (!this.directory) return;
    try {
      fs.writeFileSync(path.join(this.directory, 'status.json'), JSON.stringify({
        writeFailures: this.writeFailures,
        dropped: this.dropped,
        rotated: this.rotated,
        invalid: this.invalidRows
      }));
    } catch {
      this.writeFailures += 1;
    }
  }
}

module.exports = { FeedbackDiagnostics, STORED_EVENTS, OPERATIONS, CODES };
