'use strict';
(() => {
 const status = $('exchange-status'), out = $('data-export'), into = $('data-import');
 const dialog = node('dialog', 'exchange-dialog'), heading = node('h2'), body = node('div', 'exchange-body');
 const controls = node('div', 'settings-actions');
 const cancel = button('取消', 'button secondary', cancelReview);
 const confirm = button('继续', 'button primary', () => {});
 const phases = {
  waiting: '等待当前任务保存后继续…',
  checking: '正在检查数据包及文件校验值…',
  planning: '正在比对本机内容，准备合并预览…',
  preparingMerge: '正在核对本机变化并准备合并…',
  merging: '正在合并并保存数据…',
  exporting: '正在整理并保存数据包…'
 };
 let request = null, unavailable = false;
 controls.append(cancel, confirm);
 dialog.append(heading, body, controls);
 document.body.append(dialog);

 function setStatus(message) {
  window.ReaderNotices?.reset(status);
  status.hidden = false;
  status.textContent = message;
 }
 function buttons() { out.disabled = into.disabled = unavailable || !!request; }
 function advance(phase, message, newId = false) {
  if (newId) request.id = crypto.randomUUID();
  request.phase = phase;
  setStatus(message);
 }
 function finish(message, error = false) {
  const owner = request;
  request = null;
  dialog.close();
  buttons();
  setStatus(message);
  if (error) window.ReaderNotices?.decorate(status, {scope: owner.workspace + '|exchange', key: owner.id});
 }
 function start(phase, action, message) {
  if (request || unavailable || !state.workspace) return;
  request = {id: crypto.randomUUID(), workspace: state.workspace, phase};
  buttons();
  setStatus(message);
  send({action, requestId: request.id});
 }
 out.onclick = () => start('exportObjects', 'exchangeObjects', '正在读取可导出的本地对象…');
 into.onclick = () => start('inspect', 'chooseDataImport', '请选择 .wrdpack 数据包，检查后再确认合并。');
 function cancelReview() {
  if (request?.phase === 'review') {
   advance('discard', '正在关闭本次检查…', true);
   dialog.close();
   send({action: 'exchangeDiscard', id: request.plan, requestId: request.id});
  } else if (request?.phase === 'selectObjects') {
   finish('已取消导出。');
  }
 }
 dialog.addEventListener('cancel', event => {
  event.preventDefault();
  cancelReview();
 });

 function label(o) { return (o.kind === 'post' ? '博文：' : '用户：') + (o.label || o.nickname || o.author || o.title || o.id) + ' · ' + o.id; }
 function summary(s) {
  body.replaceChildren();
  if (s.reinspection) body.append(node('p', 'field-hint', '已重新校验原数据包，将按当前本机数据生成新计划。已保存内容、已读状态和旧事务证据保留。'));
  if (s.compatibility?.optionalDateFiles) body.append(node('p', 'field-hint', '已兼容 ' + numeric(s.compatibility.optionalDateFiles) + ' 份旧版空日期内容，正文不变，原数据包保留。'));
  const objectCount = s.objectCount ?? s.objects.length;
  body.append(node('p', '', '涉及 ' + numeric(objectCount) + ' 个对象，预计新增 ' + numeric(s.added) + ' 条、重复 ' + numeric(s.duplicate) + ' 条、版本差异 ' + numeric(s.conflicts) + ' 条独立记录。'));
  const list = node('ul');
  for (const o of s.objects) list.append(node('li', '', label(o)));
  body.append(list);
  if (objectCount > s.objects.length) body.append(node('p', 'field-hint', '已显示前 ' + numeric(s.objects.length) + ' 个对象。确认后处理全部 ' + numeric(objectCount) + ' 个对象。'));
  body.append(node('p', 'field-hint', '另有 ' + numeric(s.contexts) + ' 条引用上下文、' + numeric(s.incomplete) + ' 条不完整记录。上下文不计入正式条数。'));
  body.append(node('p', 'field-hint', '本机已有完整正文、订阅、备注、已读及费用保持原样。可补全的评论正文与不同版本的原始证据一并保存。'));
  if (s.ignoredProgress) body.append(node('p', 'field-hint', '此旧数据包中的检查位置和待续任务留在原电脑。本机进度继续使用。'));
  if (s.warnings?.length) {
   const details = node('details'), warnings = node('ul');
   details.append(node('summary', '', '查看导入说明'));
   for (const warning of s.warnings) warnings.append(node('li', '', warning));
   details.append(warnings);
   if (s.warningCount > s.warnings.length) details.append(node('p', 'field-hint', '已显示 ' + numeric(s.warnings.length) + ' 项，共 ' + numeric(s.warningCount) + ' 项。'));
   body.append(details);
  }
  body.append(node('p', 'field-hint', '新增费用 0 credits。导入完成后，可在用户／博文页面导出 HTML 阅读。'));
 }

 function selectExportObjects(objects) {
  heading.textContent = '导出数据包';
  body.replaceChildren();
  const allLabel = node('label', 'check-line'), allBox = node('input');
  allBox.type = 'checkbox';
  allBox.checked = true;
  allLabel.append(allBox, node('span', '', '全部用户与博文'));
  const list = node('div', 'exchange-objects'), checks = [];
  for (const o of objects) {
   const item = node('label', 'check-line'), input = node('input');
   input.type = 'checkbox';
   input.checked = input.disabled = true;
   checks.push({input, object: {kind: o.kind, id: o.id}});
   item.append(input, node('span', '', label(o)));
   list.append(item);
  }
  body.append(allLabel, list,
   node('p', 'field-hint', '包含已保存的独立正文、引用、内容响应、缓存图片和可验证证据。不会导出登录信息、费用、备注、已读状态或 HTML。'),
   node('p', 'field-hint', '数据包自动无损压缩，接收方请使用最新版 Weibo Reader。'));
  allBox.onchange = () => { for (const {input} of checks) input.disabled = allBox.checked; };
  confirm.textContent = '选择保存位置…';
  confirm.disabled = !checks.length;
  confirm.onclick = () => {
   const selection = allBox.checked ? 'all' : checks.filter(c => c.input.checked).map(c => c.object);
   if (Array.isArray(selection) && !selection.length) { toast('请至少选择一个对象', true); return; }
   advance('export', '请选择数据包的保存位置。', true);
   dialog.close();
   send({action: 'chooseDataExport', requestId: request.id, selection});
  };
  dialog.showModal();
 }

 function engineLost() {
  unavailable = true;
  if (!request) { buttons(); return; }
  const messages = {
   commit: '合并中断。请重新打开应用，已登记的合并将自动核对并续接。',
   discard: '关闭检查时连接中断。请重新打开应用，本次未开始合并。',
   export: '导出中断。请核对所选位置的文件，再重新打开应用重试。',
   exportObjects: '未能读取导出对象。请重新打开应用后重试。',
   selectObjects: '导出未开始。请重新打开应用后重试。'
  };
  finish(messages[request.phase] || '数据包检查中断，未开始合并。请重新打开应用后重新检查原数据包。', true);
 }

 window.dataExchangeReceive = event => {
  const {type, workspace, requestId} = event;
  if (type === 'library' && request && workspace !== request.workspace) {
   request = null;
   dialog.close();
   setStatus('');
   buttons();
   return;
  }
  const matches = request && request.workspace === state.workspace && (!workspace || workspace === request.workspace) && requestId === request.id;
  if (type === 'engineTransportError' || type === 'engineStopped') {
   if ((!workspace || workspace === state.workspace) && (!requestId || matches)) engineLost();
   return !!requestId;
  }
  if (!matches) return;
  const phase = request.phase;
  if (type === 'exchangeUnavailable') { engineLost(); return true; }
  if (type === 'foregroundQueued' && ['inspect', 'export', 'commit'].includes(phase)) { setStatus(phases.waiting); return; }
  if (type === 'foregroundDequeued' && event.cancelled && ['inspect', 'export', 'commit'].includes(phase)) {
   finish('已取消等待，本次操作未开始。'); return;
  }
  if (type === 'exchangeProgress' && ['inspect', 'export', 'commit'].includes(phase) && Object.hasOwn(phases, event.phase)) setStatus(phases[event.phase]);
  if (type === 'exchangeCancelled') finish('已取消，没有修改本地数据。');
  if (type === 'exchangeError' || type === 'foregroundRejected') {
   finish((event.message || '数据包处理未完成。') + (event.recoveryNeeded ? ' 已保存恢复事务；重新打开应用后安全续接。' : ''), true);
   return true;
  }
  if (type === 'exchangeObjects' && phase === 'exportObjects') {
   advance('selectObjects', '请选择要导出的对象。');
   selectExportObjects(event.objects);
  }
  if (type === 'exchangeInspected' && phase === 'inspect') {
   request.plan = event.id;
   advance('review', '数据包校验完成，等待确认合并。');
   heading.textContent = '确认导入并合并';
   summary(event.summary);
   confirm.disabled = false;
   confirm.textContent = '导入并合并';
   confirm.onclick = () => {
    advance('commit', phases.preparingMerge, true);
    dialog.close();
    send({action: 'exchangeCommit', id: request.plan, requestId: request.id});
   };
   dialog.showModal();
  }
  if (type === 'exchangeDiscarded' && phase === 'discard') finish('已取消，未修改本机资料。');
  if (type === 'exchangeExported' && phase === 'export') {
   const warnings = event.warningCount ?? event.warnings?.length ?? 0;
   finish('数据包已保存：' + event.file + ' · 新增 0 credits' + (warnings ? ' · ' + numeric(warnings) + ' 项旧格式内容或进度未包含，请保留原始目录。' : ''));
  }
  if (type === 'exchangeImported' && phase === 'commit') {
   finish(event.noChanges ? '数据已存在，无需重复导入。新增 0 credits。' :
    '合并完成：新增 ' + numeric(event.added || 0) + ' 条，重复 ' + numeric(event.duplicate || 0) + ' 条，保留 ' +
    numeric(event.conflicts || 0) + ' 项版本差异。新增 0 credits。' + (event.partial ? ' 部分进度未复用，正文已保留。' : ''));
  }
 };
})();
