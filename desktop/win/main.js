'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { managementExternalURL } = require('./external-links');
const { appVersion } = require('../../scripts/app-version');
const { FeedbackDiagnostics } = require('./feedback-diagnostics');
const { createUiEventQueue } = require('./ui-event-queue');
const { resolveAppRoots } = require('./paths');

// Prefer Chinese UI chrome and skip unused Chromium startup work before ready.
app.commandLine.appendSwitch('lang', 'zh-CN');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,SpareRendererForSitePerProcess');

const projectRoot = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..', '..');
const { appRoot: APP_ROOT, engineRoot: ENGINE_ROOT } = resolveAppRoots({
  isPackaged: app.isPackaged,
  appPath: projectRoot,
  resourcesPath: process.resourcesPath
});
const ROOT = APP_ROOT;
const pkg = require(path.join(APP_ROOT, 'package.json'));
const versionInfo = appVersion(pkg);
const SHELL_STATE = path.join(app.getPath('userData'), 'shell-state.json');
const DEFAULT_WORKSPACE = path.join(app.getPath('appData'), 'selnokk.weibo.reader');
const RUNTIME_LOGS = path.join(DEFAULT_WORKSPACE, 'private', 'runtime-logs');
const APP_ICON = path.join(APP_ROOT, 'build', 'icon.ico');

const {
  LOCAL_ACTIONS,
  ACCOUNT_ACTIONS,
  FORWARD_ACTIONS,
  TRANSPORT_SAFE
} = require('./shell-actions');

const feedback = new FeedbackDiagnostics({ version: versionInfo.version, build: versionInfo.build });
let feedbackPreview = null;
let feedbackRequest = '';

let mainWindow = null;
let engine = null;
let engineInput = null;
let outputBuffer = Buffer.alloc(0);
let workspace = DEFAULT_WORKSPACE;
let acceptedWorkspace = null;
let acceptedLibraryAcknowledgment = null;
let uiReady = false;
let documentEpoch = 1;
let transportFailed = false;
let quitting = false;
let busy = false;
let automaticCollection = false;
let savingData = false;
let ownedPID = 0;
let ownedAccountPID = 0;
let localWriters = new Set();
let exchangeWriter = null;
let workspaceSelection = null;
let startupBootstrapSent = false;
let startupWriter = null;
const uiEventQueue = createUiEventQueue();

function readShellState() {
  try {
    const value = JSON.parse(fs.readFileSync(SHELL_STATE, 'utf8'));
    if (typeof value.workspace === 'string' && path.isAbsolute(value.workspace)) return value;
  } catch { /* first launch */ }
  return {};
}

function writeShellState(next) {
  fs.mkdirSync(path.dirname(SHELL_STATE), { recursive: true });
  fs.writeFileSync(SHELL_STATE, JSON.stringify(next, null, 2));
}

function persistWorkspace(next) {
  writeShellState({ ...readShellState(), workspace: next });
}

function createWindow() {
  const saved = readShellState();
  if (typeof saved.workspace === 'string' && path.isAbsolute(saved.workspace)) workspace = saved.workspace;
  fs.mkdirSync(workspace, { recursive: true });

  const appInfo = JSON.stringify({ version: versionInfo.version });
  const windowOptions = {
    width: 1240,
    height: 850,
    minWidth: 980,
    minHeight: 700,
    title: 'Weibo Reader',
    show: false,
    backgroundColor: '#f7f8fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: [`--weibo-app-info=${appInfo}`]
    }
  };
  if (fs.existsSync(APP_ICON)) windowOptions.icon = APP_ICON;
  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = pathToFileURL(path.join(ENGINE_ROOT, 'desktop', 'ui', 'index.html')).href;
    if (url.split(/[?#]/)[0] !== allowed.split(/[?#]/)[0]) event.preventDefault();
  });

  // UI is asarUnpack'd with lib/ so relative ../../lib/*.js resolves on disk.
  mainWindow.loadFile(path.join(ENGINE_ROOT, 'desktop', 'ui', 'index.html'));
  setImmediate(() => startEngine());
}

function pathToFileURL(filePath) {
  const resolved = path.resolve(filePath);
  return { href: 'file:///' + resolved.replace(/\\/g, '/') };
}

function startEngine() {
  if (engine && !engine.killed) return;
  const bridge = path.join(ENGINE_ROOT, 'desktop', 'bridge.js');
  const startupWorkspace = workspace;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    NODE_TLS_REJECT_UNAUTHORIZED: '1',
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '')
  };
  const child = spawn(process.execPath, [bridge, '--workspace', startupWorkspace, '--wait-for-ready', '--native-startup'], {
    cwd: ENGINE_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  engine = child;
  engineInput = child.stdin;
  outputBuffer = Buffer.alloc(0);
  transportFailed = false;

  child.stdout.on('data', chunk => consume(chunk));
  child.stderr.on('data', chunk => {
    const text = chunk.toString('utf8');
    if (text) deliver({ type: 'log', message: text, level: 'error' });
  });
  child.on('exit', () => {
    engine = null;
    engineInput = null;
    if (quitting) {
      if (!app.isQuittingDone) {
        app.isQuittingDone = true;
        app.exit(0);
      }
      return;
    }
    feedback.observe({ type: 'engineStopped' });
    deliver({ type: 'engineStopped', message: '运行引擎已结束，请重新打开应用。' });
  });
  child.on('error', () => {
    feedback.observe({ type: 'engineStartFailed' });
  });

  if (!startupBootstrapSent) {
    startupBootstrapSent = true;
    const requestId = 'native-startup:' + cryptoRandom();
    startupWriter = { requestId, workspace: startupWorkspace };
    localWriters.add(requestId);
    send({ action: 'bootstrap', workspace: startupWorkspace, requestId });
  }
}

function cryptoRandom() {
  return require('node:crypto').randomUUID();
}

function consume(chunk) {
  outputBuffer = Buffer.concat([outputBuffer, chunk]);
  while (true) {
    const newline = outputBuffer.indexOf(10);
    if (newline < 0) break;
    const line = outputBuffer.subarray(0, newline);
    outputBuffer = outputBuffer.subarray(newline + 1);
    if (line.length > 4 * 1024 * 1024) {
      failTransport('运行引擎消息超过安全长度。已停止后续请求；已有数据保留，请重新打开应用。');
      continue;
    }
    if (transportFailed) continue;
    let event;
    try {
      event = JSON.parse(line.toString('utf8'));
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('not object');
    } catch {
      failTransport('运行引擎返回了无法读取的消息。已停止后续请求；已有数据保留，请重新打开应用。');
      continue;
    }
    handleEngineEvent(event);
  }
  if (outputBuffer.length > 4 * 1024 * 1024) {
    outputBuffer = Buffer.alloc(0);
    failTransport('运行引擎消息超过安全长度。已停止后续请求；已有数据保留，请重新打开应用。');
  }
}

function handleEngineEvent(event) {
  const type = event.type || '';
  if (type === 'presentationSnapshotPart') {
    if (uiReady && event.workspace === workspace && event.documentEpoch === documentEpoch) deliver(event);
    return;
  }
  if (type === 'frontendState') {
    if (event.workspace !== workspace || (event.documentEpoch ?? documentEpoch) !== documentEpoch) return;
    if (event.active?.type === 'started' && event.active.workspace === workspace) deliver(event.active);
    else if (event.preparing?.type === 'preparing' && event.preparing.workspace === workspace) deliver(event.preparing);
    if (event.credits?.type === 'credits' && event.credits.workspace === workspace) deliver(event.credits);
    return;
  }
  feedback.observe(event);
  if (type === 'started') {
    busy = true;
    automaticCollection = event.automatic === true;
    ownedPID = Number(event.pid) || 0;
    savingData = event.query?.syncOnly === true;
  }
  if (type === 'library' && typeof event.workspace === 'string' && path.isAbsolute(event.workspace)) {
    acceptedWorkspace = event.workspace;
    persistWorkspace(event.workspace);
    workspace = event.workspace;
    const authorization = event.nativeWorkspaceId || event.bootstrapId;
    if (typeof authorization === 'string' && authorization && Buffer.byteLength(authorization) <= 256) {
      const acknowledgment = [acceptedWorkspace, authorization].join('\0');
      if (acceptedLibraryAcknowledgment !== acknowledgment) {
        acceptedLibraryAcknowledgment = acknowledgment;
        send({ action: 'nativeWorkspaceAccepted', workspace: acceptedWorkspace, bootstrapId: authorization });
      }
    }
  }
  if (type === 'localWriteState' && typeof event.requestId === 'string') {
    if (startupWriter && event.requestId === startupWriter.requestId) {
      if (event.workspace === startupWriter.workspace && event.busy === false) {
        localWriters.delete(event.requestId);
        startupWriter = null;
      }
    } else if (event.busy === true) localWriters.add(event.requestId);
    else localWriters.delete(event.requestId);
  }
  if (['foregroundQueued', 'manualQueued'].includes(type) && event.id) localWriters.add('foreground:' + event.id);
  if (type === 'foregroundDequeued' && event.id) localWriters.delete('foreground:' + event.id);
  if (type === 'exchangeBusy' && event.requestId && event.workspace === workspace) {
    if (event.busy === true && !exchangeWriter) exchangeWriter = { workspace, requestId: event.requestId };
    else if (event.busy === false && exchangeWriter?.requestId === event.requestId) exchangeWriter = null;
  }
  if (type === 'accountLoading') ownedAccountPID = Number(event.pid) || 0;
  if (type === 'preparing' || type === 'merging') {
    busy = true;
    automaticCollection = type === 'preparing' && event.automatic === true;
  }
  if (type === 'merged' || (type === 'error' && ownedPID === 0)) {
    busy = false;
    automaticCollection = false;
  }
  if (type === 'finished' && event.kind !== 'account') {
    busy = false;
    automaticCollection = false;
    ownedPID = 0;
    savingData = false;
  }
  if (type === 'open' && typeof event.path === 'string') {
    openPath(event.path, event.kind || 'report')
      .then(() => completeBrowserOpen(event))
      .catch(error => completeBrowserOpen(event, error.message || String(error)));
    return;
  }
  deliver(event);
}

async function openPath(target, kind) {
  const error = await shell.openPath(target);
  if (error) throw new Error(error || (kind === 'folder' ? '无法打开文件夹' : '无法打开报告'));
}

function completeBrowserOpen(event, error) {
  const reply = {
    type: error ? 'browserOpenFailed' : 'browserOpened',
    id: event.id || '',
    workspace: event.workspace || workspace
  };
  if (event.requestId) reply.requestId = event.requestId;
  if (error) {
    reply.message = error;
    feedback.observe({ type: 'browserOpenFailed' });
  }
  deliver(reply);
  if (event.handoffTicket) {
    localWriters.add(event.handoffTicket);
    send({
      action: 'reportHandoff',
      token: event.handoffTicket,
      success: !error,
      requestId: event.handoffTicket,
      workspace: reply.workspace
    });
  } else if (!error && event.unreadTicket) {
    send({ action: 'reportOpened', token: event.unreadTicket, workspace: reply.workspace });
  }
}

function deliver(event) {
  if (!uiReady) {
    uiEventQueue.enqueue(event);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const json = JSON.stringify(event);
  mainWindow.webContents.executeJavaScript(`window.weiboReceive(${json});`).catch(() => {});
}

function frontendDidBecomeReady() {
  if (uiReady) return false;
  uiReady = true;
  for (const event of uiEventQueue.flush(workspace)) deliver(event);
  send({ action: 'frontendAttach', workspace, documentEpoch });
  return true;
}

function failTransport(message) {
  if (transportFailed) return;
  transportFailed = true;
  feedback.observe({ type: 'transportFailed' });
  deliver({ type: 'engineTransportError', message });
  send({ action: 'shutdown' });
}

function send(original) {
  feedback.capture(original);
  if (transportFailed && !['stop', 'shutdown'].includes(original.action)) return;
  if (!engineInput || engineInput.destroyed) {
    if (String(original.action || '').startsWith('exchange')) failTransport('无法连接运行引擎，请重新打开应用。');
    else if (original.action === 'pricingQuote') {
      deliver({
        type: 'pricingQuoteError',
        requestId: original.requestId,
        workspace: original.workspace || workspace,
        message: '无法连接运行引擎，请重新打开应用。'
      });
    } else deliver({ type: 'error', message: '无法连接运行引擎，请重新打开应用。' });
    return;
  }
  try {
    engineInput.write(JSON.stringify(original) + '\n');
  } catch {
    if (String(original.action || '').startsWith('exchange')) failTransport('无法连接运行引擎，请重新打开应用。');
    else if (original.action === 'pricingQuote') {
      deliver({
        type: 'pricingQuoteError',
        requestId: original.requestId,
        workspace: original.workspace || workspace,
        message: '无法连接运行引擎，请重新打开应用。'
      });
    } else deliver({ type: 'error', message: '无法连接运行引擎，请重新打开应用。' });
  }
}

function forwardExchange(body) {
  if (body.workspace !== workspace || !body.requestId) return;
  if (quitting || transportFailed || !engineInput || (engine && engine.killed)) {
    deliver({ type: 'exchangeUnavailable', workspace: body.workspace, requestId: body.requestId });
    return;
  }
  send(body);
}

function forwardLocalDataRequest(body) {
  const action = body.action;
  if (!LOCAL_ACTIONS.has(action)) return false;
  if (action === 'postAuthorAvatar') {
    if (body.workspace !== workspace || typeof body.requestId !== 'string') return true;
    if (transportFailed || !engineInput || (engine && engine.killed)) {
      deliver({
        type: 'postAuthorAvatarResult', updated: false, code: 'ENGINE_STOPPED',
        message: '运行引擎未连接，请重新打开应用后重试。',
        requestId: body.requestId, workspace: body.workspace, postId: body.postId, authorUid: body.authorUid
      });
      return true;
    }
    localWriters.add(body.requestId);
    send(body);
    return true;
  }
  if (['taskFuturePreview', 'taskFutureChoose'].includes(action) && (transportFailed || !engineInput || (engine && engine.killed))) {
    deliver({
      type: 'taskFutureError', code: 'ENGINE_STOPPED',
      message: '运行引擎未连接；请重新打开应用后核对恢复起点。已有数据保留。',
      requestId: body.requestId, workspace: body.workspace, uid: body.uid, kind: body.kind, taskId: body.taskId
    });
    return true;
  }
  if (['localExport', 'searchOpen', 'taskGapIgnore', 'taskNoticeDismiss', 'recoveryRetry', 'taskFutureChoose'].includes(action) && body.requestId) {
    localWriters.add(body.requestId);
  }
  send(body);
  return true;
}

async function handleUiMessage(body) {
  if (!body || typeof body !== 'object' || typeof body.action !== 'string') return;
  const action = body.action;
  if (transportFailed && !action.startsWith('exchange') && !TRANSPORT_SAFE.has(action)) {
    if (action === 'pricingQuote' && body.requestId) {
      deliver({
        type: 'pricingQuoteError',
        requestId: body.requestId,
        workspace: body.workspace || workspace,
        message: '运行引擎未连接，请重新打开应用后重试。'
      });
    }
    return;
  }
  if (await handleFeedback(body)) return;
  if (forwardLocalDataRequest(body)) return;
  if (ACCOUNT_ACTIONS.has(action)) {
    if (body.workspace === workspace) send(body);
    return;
  }
  switch (action) {
    case 'ready':
      frontendDidBecomeReady();
      break;
    case 'startupListReady':
      feedback.observe({ type: 'startupListReady' });
      break;
    case 'chooseWorkspace':
      await chooseWorkspace(body);
      break;
    case 'chooseDataExport':
      await chooseDataExport(body);
      break;
    case 'chooseDataImport':
      await chooseDataImport(body);
      break;
    case 'exchangeObjects':
    case 'exchangeCommit':
    case 'exchangeDiscard':
      forwardExchange(body);
      break;
    case 'copy':
      if (typeof body.text === 'string' && Buffer.byteLength(body.text) < 4 * 1024 * 1024) {
        clipboard.writeText(body.text);
        deliver({ type: 'copied', success: true });
      } else deliver({ type: 'copied', success: false });
      break;
    case 'external': {
      const href = managementExternalURL(body.url);
      if (href) {
        try { await shell.openExternal(href); }
        catch { deliver({ type: 'error', message: '无法打开微博链接' }); }
      }
      break;
    }
    default:
      if (FORWARD_ACTIONS.has(action)) send(body);
      break;
  }
}

async function handleFeedback(body) {
  const action = body.action;
  if (!['feedbackPreview', 'feedbackCopy', 'feedbackExport'].includes(action)) return false;
  const requestId = body.requestId || '';
  if (action === 'feedbackPreview' || action === 'feedbackExport') {
    feedbackRequest = requestId;
    const snap = feedback.makeSnapshot(versionInfo.version, versionInfo.build);
    if (feedbackRequest !== requestId) return true;
    if (action === 'feedbackExport') {
      await saveRuntimeLog(snap.bytes, requestId);
      return true;
    }
    const snapshotId = cryptoRandom();
    feedbackPreview = { id: snapshotId, bytes: snap.bytes, text: snap.text };
    const preview = snap.bytes.subarray(0, PREVIEW_LIMIT).toString('utf8');
    deliver({
      type: 'feedbackPreview',
      requestId,
      snapshotId,
      text: snap.text,
      preview,
      json: preview,
      truncated: snap.bytes.length > PREVIEW_LIMIT,
      summary: snap.summary
    });
    return true;
  }
  if (!feedbackPreview || feedbackPreview.id !== body.snapshotId) {
    deliver({ type: 'feedbackResult', requestId, status: 'preview-required' });
    return true;
  }
  try {
    clipboard.writeText(feedbackPreview.text);
    deliver({ type: 'feedbackResult', requestId, status: 'copied' });
  } catch {
    deliver({ type: 'feedbackResult', requestId, status: 'failed' });
  }
  return true;
}

const PREVIEW_LIMIT = 24 * 1024;

async function saveRuntimeLog(bytes, requestId) {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'Weibo-Reader-Runtime.log',
    filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
  });
  if (result.canceled || !result.filePath) {
    deliver({ type: 'feedbackResult', requestId, status: 'cancelled' });
    return;
  }
  try {
    fs.writeFileSync(result.filePath, bytes);
    deliver({ type: 'feedbackResult', requestId, status: 'saved' });
  } catch {
    deliver({ type: 'feedbackResult', requestId, status: 'failed' });
  }
}

async function chooseWorkspace(body) {
  if (quitting || transportFailed || exchangeWriter || workspaceSelection || (busy && !automaticCollection)) return;
  const origin = body.workspace || workspace;
  if (origin !== workspace) return;
  const requestId = body.requestId || cryptoRandom();
  if (!requestId || Buffer.byteLength(requestId) > 4096) return;
  workspaceSelection = { workspace: origin, requestId };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择资料目录',
    properties: ['openDirectory', 'createDirectory']
  });
  const selection = workspaceSelection;
  workspaceSelection = null;
  if (!selection || quitting || result.canceled || !result.filePaths[0]) return;
  send({
    action: 'workspace',
    workspace: selection.workspace,
    originWorkspace: selection.workspace,
    requestId: selection.requestId,
    path: result.filePaths[0]
  });
}

async function chooseDataExport(body) {
  if (body.workspace !== workspace || !body.requestId) return;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出数据包',
    defaultPath: 'WeiboReader-数据-' + Math.floor(Date.now() / 1000) + '.wrdpack'
  });
  if (body.workspace !== workspace) return;
  if (result.canceled || !result.filePath) {
    deliver({ type: 'exchangeCancelled', workspace: body.workspace, requestId: body.requestId });
    return;
  }
  forwardExchange({
    action: 'exchangeExport',
    workspace: body.workspace,
    path: result.filePath,
    selection: body.selection || 'all',
    requestId: body.requestId
  });
}

async function chooseDataImport(body) {
  if (body.workspace !== workspace || !body.requestId) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '检查数据包',
    properties: ['openFile'],
    filters: [{ name: 'Weibo Reader Pack', extensions: ['wrdpack'] }]
  });
  if (body.workspace !== workspace) return;
  if (result.canceled || !result.filePaths[0]) {
    deliver({ type: 'exchangeCancelled', workspace: body.workspace, requestId: body.requestId });
    return;
  }
  forwardExchange({
    action: 'exchangeInspect',
    workspace: body.workspace,
    path: result.filePaths[0],
    requestId: body.requestId
  });
}

function requestQuit() {
  if (quitting) return;
  quitting = true;
  feedback.observe({ type: 'quitRequested' });
  send({ action: 'shutdown' });
  const timer = setInterval(() => {
    if (!engine || engine.killed) {
      clearInterval(timer);
      if (!app.isQuittingDone) {
        app.isQuittingDone = true;
        app.exit(0);
      }
      return;
    }
    if (!savingData && ownedPID === 0 && !exchangeWriter && localWriters.size === 0) {
      try { engine.kill(); } catch { /* ignore */ }
    }
  }, 1000);
  setTimeout(() => {
    if (engine && !engine.killed) {
      try { engine.kill(); } catch { /* ignore */ }
    }
    if (!app.isQuittingDone) {
      app.isQuittingDone = true;
      app.exit(0);
    }
  }, 8000);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  feedback.enablePersistence(RUNTIME_LOGS);
  feedback.observe({ type: 'appStarted' });
  ipcMain.on('weibo-ui', (_event, body) => {
    Promise.resolve(handleUiMessage(body)).catch(error => {
      deliver({ type: 'error', message: error.message || String(error) });
    });
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('will-quit', () => {
  feedback.finishSession();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') requestQuit();
});

app.on('before-quit', event => {
  if (quitting && (!engine || engine.killed)) return;
  event.preventDefault();
  requestQuit();
});
