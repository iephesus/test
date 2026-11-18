'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReaderHistoryView = api;
})(typeof window === 'object' ? window : globalThis, function () {
  function ownsHistory(state, event, requireKind = false) {
    const owner = state.historyRequest;
    return state.view === 'history' && !!owner
      && owner.workspace === state.workspace
      && event.requestId === owner.requestId
      && event.target === owner.target
      && event.mode === owner.mode
      && (!requireKind || event.workspace === owner.workspace)
      && ((!requireKind && !event.targetKind) || event.targetKind === owner.targetKind);
  }

  function create(deps) {
    const {
      getState, $, node, button, send, toast, view, numeric, dateText, timeSpan,
      markCommentDirection, modes, internal, currentTarget, mode, uidOf,
      createSnapshotReader, weiboReceive
    } = deps;
    const snapshots = createSnapshotReader(event => weiboReceive(event));

    function show(target = currentTarget(), which = mode()) {
      const state = getState();
      if (state.view !== 'history') state.historyReturn = state.view;
      view('history');
      snapshots.reset();
      const requestId = crypto.randomUUID();
      const post = which === 'post-comments';
      state.historyRequest = {
        requestId,
        workspace: state.workspace,
        target: post ? ReaderUX.postId(target) : uidOf(target),
        targetKind: post ? 'post' : 'user',
        mode: which
      };
      window.ReaderEntityActions?.renderHistoryContinuations(state.historyRequest.targetKind, state.historyRequest.target);
      $('history-title').textContent = (state.accounts.find(a => a.uid === uidOf(target))?.nickname || target) + ' · 获取历史';
      $('history-summary').textContent = '仅汇总当前数据的已保存获取记录';
      $('history-cost-summary').hidden = true;
      $('history-rows').textContent = '正在读取本地更新记录…';
      send({ action: 'updateHistory', target, mode: which, requestId });
    }

    function renderCost(records) {
      const total = ReaderHistoryCost.summarize(records);
      const root = $('history-cost-summary');
      root.replaceChildren();
      root.hidden = false;
      const main = node('div', 'history-cost-main');
      main.append(
        node('span', '', '累计消耗估算'),
        node('strong', '', total.estimatedOperations ? numeric(total.estimatedCredits) + ' credits' : total.operations ? '暂无法汇总' : '0 credits')
      );
      root.append(main);
      const notes = [];
      if (total.verifiedOperations) notes.push('可核实实扣 ' + numeric(total.verifiedCredits) + ' credits（' + total.verifiedOperations + ' 次操作）');
      if (total.unknownRequests) notes.push(total.unknownRequests + ' 次请求费用待核对');
      if (total.unpricedOperations) notes.push(total.unpricedOperations + ' 次操作缺少费用记录');
      if (total.reservedCredits) notes.push('待核对预算预留 ' + numeric(total.reservedCredits) + ' credits');
      notes.push('按返回量估算；仅当前获取历史，不含资料查询等其他操作');
      root.append(node('p', 'field-hint', notes.join(' · ')));
    }

    function entry(record) {
      const interpretation = ReaderAcquisitionFeedback.describe({
        ...record,
        syncOnly: true,
        incomplete: record.status !== 'complete',
        persistence: record.persistence
      }, {
        cancelled: ['cancelled', 'interrupted'].includes(record.status),
        code: record.status === 'failed' ? 1 : 0
      });
      const box = node('details', 'history-entry');
      const heading = node('summary');
      const time = node('strong', '', dateText(Date.parse(record.finishedAt)));
      const label = interpretation.middleGap ? '已完成 · 待补区间'
        : interpretation.goalComplete && !interpretation.pendingNew ? '已完成'
          : ({ complete: '已完成', partial: '部分完成', failed: '失败', cancelled: '已中断', interrupted: '已中断', legacy: '旧版采集审计' }[record.status] || record.status);
      heading.append(time, timeSpan(record.finishedAt), node('span', '', label));
      box.append(heading);
      const b = record.billing || {};
      const cost = b.status === 'no-content-requests'
        ? '新增取数费用 0 credits（未发出内容请求）'
        : b.balanceDecrease != null && b.balanceDecrease >= 0
          ? '余额减少 ' + numeric(b.balanceDecrease) + ' credits（余额观测）'
          : '实耗待核对';
      heading.append(node('span', 'history-cost', cost + (b.unknownRequests || b.status === 'unverified' ? ' · 费用待核实' : '')));
      const modeLine = node('p');
      const modeLabel = modes[internal[record.mode] || record.mode] || record.mode || '更新';
      modeLine.append(
        markCommentDirection(node('span', '', modeLabel), record.mode),
        ' · ' + (record.from || record.to
          ? ReaderDates.label(record.from, record.to)
          : record.before
            ? '截至 ' + record.before
            : ({ automatic: '订阅自动检查', latest: '快速检查更新', quick: '快速检查更新', regular: '常规获取', history: '常规获取', range: '常规获取 · 日期范围' }[record.operation] || '旧版记录，范围详情见审计'))
      );
      box.append(
        modeLine,
        node('p', '', `本次覆盖 ${numeric(record.records)} 条 · 本地复用 ${numeric(record.reusedRecords)} 条 · 新保存 ${numeric(record.addedRecords)} 条 · 接口返回 ${numeric(record.newReturned)} 条 · API ${numeric(record.apiCalls)} 次 · 缓存 ${numeric(record.cachedCalls)} 次`)
      );
      const seconds = Math.max(0, Math.round((Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000));
      box.append(node('p', 'field-hint', `开始 ${dateText(Date.parse(record.startedAt))} · 耗时 ${Number.isFinite(seconds) ? seconds + ' 秒' : '未知'} · 按返回量估算 ${b.estimatedCredits == null ? '未知' : numeric(b.estimatedCredits) + ' credits'}`));
      if (b.balanceBefore != null || b.balanceAfter != null)
        box.append(node('p', 'field-hint', `余额查询 ${numeric(b.balanceBefore)} → ${numeric(b.balanceAfter)} credits`));
      if (record.operation)
        box.append(node('p', 'field-hint', '读取条数上限：' + (record.requestedLimit == null ? '不限' : numeric(record.requestedLimit)) + ' · 每接口请求上限：' + (record.requestLimit == null ? '不限' : numeric(record.requestLimit))));
      for (const q of record.autoRequests || []) {
        const request = node('p', 'field-hint');
        const direction = { sent: '发出', received: '收到', 'post-comments': '博文评论' }[q.kind];
        request.append(
          markCommentDirection(node('span', '', direction || q.kind || '方向未确认'), q.kind),
          ' · ' + dateText(Date.parse(q.at)) + ' · 请求 ' + numeric(q.count) + ' / 返回 ' + numeric(q.returned) + ' 条 · 单价 ' + numeric(q.unitPrice) + ' · ' + (q.status === 'estimated' ? '估算 ' + numeric(q.estimatedCredits) + ' credits' : '费用待核对，预留 ' + numeric(q.reservedCredits) + ' credits')
        );
        box.append(request);
      }
      box.append(node('p', '', interpretation.title), node('p', 'field-hint', interpretation.detail));
      if (record.reason) box.append(node('p', 'field-hint', record.reason));
      return box;
    }

    function render(records) {
      renderCost(records);
      const root = $('history-rows');
      root.replaceChildren();
      $('history-summary').textContent = records.length + ' 次操作 · 账单信息与数据保存在本机';
      if (!records.length) {
        root.append(node('p', 'field-hint', '暂无可用的更新账单。旧版本采集没有记录的实扣费用无法事后推算。'));
        return;
      }
      const batchSize = 40;
      const list = node('div');
      root.append(list);
      let cursor = 0;
      const more = node('button', 'button secondary');
      more.type = 'button';
      function appendBatch() {
        const end = Math.min(cursor + batchSize, records.length);
        list.append(...records.slice(cursor, end).map(entry));
        cursor = end;
        more.hidden = cursor === records.length;
        if (!more.hidden) more.textContent = '显示更多获取记录（剩余 ' + numeric(records.length - cursor) + ' 条）';
      }
      more.onclick = appendBatch;
      appendBatch();
      if (!more.hidden) root.append(more);
    }

    function receive(event) {
      const state = getState();
      if (event.type === 'updateHistory') {
        if (!ownsHistory(state, event)) return true;
        render(event.records || []);
        return true;
      }
      if (event.type === 'updateHistoryError') {
        if (!ownsHistory(state, event, true)) return true;
        const { target, mode: which } = state.historyRequest;
        $('history-rows').replaceChildren(
          node('p', 'field-hint', event.message),
          button('重试读取', 'button secondary', () => show(target, which))
        );
        return true;
      }
      if (['homeUsers', 'postsHome'].includes(event.type) && state.view === 'history' && state.historyRequest) {
        const { targetKind, target } = state.historyRequest;
        window.ReaderEntityActions?.renderHistoryContinuations(targetKind, target);
      }
      return false;
    }

    function receiveSnapshot(event) {
      if (!ownsHistory(getState(), event, true)) return false;
      snapshots.receive(event);
      return true;
    }

    function bind() {
      $('database-history').addEventListener('click', () => {
        if (!currentTarget()) {
          toast('请先选择目标用户或微博', true);
          return;
        }
        show();
      });
      $('history-back').addEventListener('click', () => view(getState().historyReturn || 'create'));
    }

    return {
      snapshots,
      owns: (event, requireKind) => ownsHistory(getState(), event, requireKind),
      show,
      receive,
      receiveSnapshot,
      bind,
      reset: () => snapshots.reset()
    };
  }

  return { ownsHistory, create };
});
