'use strict';
// Task progress / result card rendering (from app.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReaderTaskCard = api;
})(typeof window === 'object' ? window : globalThis, function () {
  function resultExplanationLabel(done) {
    const feedback = done.feedback;
    if (!feedback?.saved) {
      return done.state === 'interrupted' ? '获取已中断'
        : done.state === 'failed' ? '获取未完成' : '保存结果待确认';
    }
    const issue = feedback.issues.find(value => !value.missingBodyCount && !(feedback.middleGap && value.code === 'new'));
    return issue?.text || '结果待确认';
  }

  function create(deps) {
    const {
      state, $, modes, numeric, markCommentDirection, query, contentTaskBusy,
      entityStatus, taskActivity, status, renderAvailability, renderReturned,
      renderEntityInventory, renderTaskActivity, hasSeparateContinuationNotice,
      renderResultGapNotice, dateText, ReaderDataQuery, ReaderUX, ReaderAcquisitionFeedback,
      ReaderTaskActivity
    } = deps;

    function resetProgressPresentation() {
      globalThis.ReaderNotices?.reset($('progress-message'));
      $('progress-message').hidden = false;
      $('result-missing-bodies').hidden = true;
      $('result-gap-notice').hidden = true;
      delete $('result-gap-notice').dataset.taskId;
      $('task-card').classList.remove('is-result');
      delete $('progress-details').dataset.resultLabel;
    }

    function setProgress(label, value, text) {
      resetProgressPresentation();
      $('progress-stage').textContent = label;
      $('progress-ratio').textContent = text || '';
      const finite = Number.isFinite(value);
      const active = contentTaskBusy() || state.localGenerating;
      $('progress-track').hidden = !active && !finite;
      $('progress-track').classList.toggle('determinate', finite);
      $('progress-track').classList.toggle('is-running', active);
      $('progress-fill').style.width = finite ? Math.max(0, Math.min(100, value * 100)) + '%' : '32%';
      if (finite) {
        $('progress-track').setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Math.round(value * 100)))));
      } else {
        $('progress-track').removeAttribute('aria-valuenow');
      }
    }

    function renderTaskParameters(q) {
      const report = q.task === 'report';
      const quick = q.syncOperation === 'quick' || q.policy === 'update';
      $('task-panel-heading').textContent = '本次任务';
      markCommentDirection($('task-title'), q.mode).textContent =
        (report ? '生成报告 · ' : quick ? '快速检查更新 · ' : '获取数据 · ') + (modes[q.mode] || q.mode);
      $('summary-policy').textContent = report
        ? '本地查看 · 0 credits'
        : quick ? '快速检查更新' : q.from || q.to ? '常规获取 · 日期范围' : '常规获取';
      $('summary-limit-label').textContent = report ? '查看范围' : quick ? '新增返回上限' : '覆盖目标';
      $('summary-limit').textContent = ReaderUX.scope(q).summary;
    }

    function renderLiveAdded(count) {
      if (!state.progressQuery?.syncOnly || state.progressQuery.preview || !Number.isSafeInteger(count) || count < 0) return;
      $('task-card').classList.add('is-acquiring');
      $('summary-limit-label').textContent = '本次新增';
      const value = numeric(count) + ' 条';
      if ($('summary-limit').textContent !== value) $('summary-limit').textContent = value;
    }

    function resetTaskCard(q = query()) {
      if ($('task-progress-dialog')?.open) $('task-progress-dialog').close();
      resetProgressPresentation();
      $('task-card').classList.remove('is-acquiring');
      $('task-panel-heading').textContent = '本次任务';
      $('continue-update').removeAttribute('data-task-id');
      state.cardFormKey = ReaderDataQuery.key(q);
      state.summary = null;
      state.credits = null;
      state.continuation = false;
      state.returnLimited = false;
      state.sources.clear();
      state.plan = [];
      state.gapWarnings = [];
      state.availability.clear();
      status('待开始');
      $('progress-stage').textContent = '等待开始';
      $('progress-ratio').textContent = '';
      $('progress-track').hidden = true;
      $('progress-track').classList.remove('is-running', 'determinate');
      $('progress-track').removeAttribute('aria-valuenow');
      $('progress-fill').style.width = '0%';
      $('cost').textContent = q.task === 'report' ? '0' : '—';
      $('cost').classList.remove('uncertain');
      renderAvailability();
      $('form-error').hidden = true;
      $('progress-message').textContent = q.task === 'report'
        ? '点击“生成并打开报告”后，使用本地数据生成。'
        : '点击“获取数据”后才会开始读取。';
      if (state.account?.balance != null) {
        $('balance-label').textContent = '上次查询余额';
        $('balance').textContent = numeric(state.account.balance) + ' credits';
      } else {
        $('balance-label').textContent = '剩余余额';
        $('balance').textContent = '尚未查询';
      }
      renderReturned({}, q);
    }

    function renderRecentTaskCard(q = query()) {
      renderEntityInventory();
      if (!entityStatus.allows() || contentTaskBusy() || state.localGenerating || state.finishingTask || q.task !== 'sync') {
        return false;
      }
      const result = taskActivity.result(q, state.workspace);
      if (!result) return false;
      renderTaskActivity();
      const done = result.outcome;
      const summary = result.summary || {};
      const fee = result.credits || {};
      const captured = result.query;
      const quick = captured.syncOperation === 'quick' || captured.policy === 'update';
      const repair = entityStatus.snapshot().repair;
      if (repair && done.feedback) {
        done.feedback = ReaderAcquisitionFeedback.describe(
          { ...result.summary, inventoryRepair: repair },
          { partialFailures: done.partialFailures }
        );
      }
      const localNotice = done.feedback?.saved && done.feedback.issues.length > 0
        && done.feedback.issues.every(issue => issue.code.startsWith('local:')) && !summary.incomplete;
      const complete = !['failed', 'interrupted', 'unverified'].includes(done.state)
        && (done.state === 'complete' || done.feedback?.goalComplete === true || localNotice
          || repair?.state === 'complete' && done.feedback?.complete);
      const coveredGap = complete && done.feedback?.middleGap;
      const issues = done.feedback?.issues || [];
      const showExplanation = !done.feedback?.saved
        || issues.some(issue => !issue.missingBodyCount && !(coveredGap && issue.code === 'new'))
        || !complete;
      $('task-panel-heading').textContent = '上次获取结果';
      markCommentDirection($('task-title'), captured.mode).textContent = modes[captured.mode] || captured.mode;
      $('summary-policy').textContent = quick
        ? '快速检查更新'
        : captured.from || captured.to ? '常规获取 · 日期范围' : '常规获取';
      $('summary-limit-label').textContent = '本次新增';
      const added = summary.addedRecords;
      $('summary-limit').textContent = done.feedback?.saved && Number.isSafeInteger(added) && added >= 0
        ? numeric(added) + ' 条' : '—';
      $('cost').textContent = fee.estimatedCredits == null
        ? (fee.unknownRequests ? '待核对' : '—')
        : numeric(fee.estimatedCredits) + (fee.unknownRequests ? ' + 待核对' : '');
      $('cost').classList.toggle('uncertain', fee.estimatedCredits == null || fee.unknownRequests > 0);
      if (fee.finalBalance != null) {
        $('balance-label').textContent = '本次结束时余额';
        $('balance').textContent = numeric(fee.finalBalance) + ' credits';
      } else if (fee.initialBalance != null && fee.estimatedCredits != null && !fee.unknownRequests) {
        $('balance-label').textContent = '本次结束时余额估算';
        $('balance').textContent = numeric(fee.initialBalance - fee.estimatedCredits) + ' credits';
      } else {
        $('balance-label').textContent = '本次结束时余额';
        $('balance').textContent = '未取得';
      }
      renderReturned({ ...summary, ...fee }, captured);
      const expectedKinds = {
        'comments-both': ['sent', 'received'],
        'comments-sent': ['sent'],
        'comments-received': ['received'],
        'post-comments': ['post-comments']
      }[captured.mode];
      const noNew = complete && !issues.length && quick && summary.records === 0 && summary.addedRecords === 0
        && expectedKinds?.every(kind => summary.sources?.some(source =>
          source.kind === kind && source.update?.verifiedNoNew === true && source.update?.timeOrderVerified === true));
      status(
        noNew ? '读取完成 · 无新增'
          : complete ? localNotice ? '读取完成 · 有提示' : '读取完成'
            : done.state === 'interrupted' ? '已中断'
              : done.feedback?.saved ? '读取未完成 · 已保存' : '读取未完成',
        complete ? 'success' : 'warning'
      );
      setProgress(noNew ? '检查完成，未发现新增' : complete ? '获取已完成' : '', complete ? 1 : null, '');
      $('task-card').classList.add('is-result');
      $('task-card').classList.remove('is-acquiring');
      if (coveredGap && result.taskId) $('result-gap-notice').dataset.taskId = result.taskId;
      renderResultGapNotice();
      const missing = $('result-missing-bodies');
      missing.hidden = !result.missingBodies.count;
      missing.textContent = missing.hidden ? ''
        : (result.missingBodies.atLeast ? '至少 ' : '') + numeric(result.missingBodies.count) + ' 个已知 ID 缺失正文';
      if (!complete) $('progress-track').hidden = true;
      $('progress-message').textContent = noNew
        ? '已核对所选方向，未发现新增。'
        : done.feedback?.detail || '保存结果待确认，请查看运行详情。';
      $('progress-message').hidden = false;
      if (showExplanation) $('progress-details').dataset.resultLabel = resultExplanationLabel(done);
      else if (issues.length) $('progress-message').hidden = true;
      if (hasSeparateContinuationNotice(captured, result)) {
        globalThis.ReaderNotices?.reset($('progress-message'));
        $('progress-message').hidden = true;
      } else if (showExplanation) {
        globalThis.ReaderNotices?.decorate($('progress-message'), {
          scope: ReaderTaskActivity.key(captured, state.workspace),
          key: result.taskId,
          ...globalThis.taskPresentationOptions?.(captured, result.taskId, result),
          externalDismiss: true
        });
      }
      return true;
    }

    function syncTaskCard(q) {
      const key = ReaderDataQuery.key(q);
      if (!state.finishingTask && !(contentTaskBusy() || state.localGenerating) && state.cardFormKey !== key) {
        resetTaskCard(q);
      }
      const active = contentTaskBusy() || state.localGenerating;
      $('progress-track').classList.toggle('is-running', active);
      if (!active && !$('progress-track').classList.contains('determinate')) $('progress-track').hidden = true;
    }

    return {
      resultExplanationLabel,
      resetProgressPresentation,
      setProgress,
      renderTaskParameters,
      renderLiveAdded,
      resetTaskCard,
      renderRecentTaskCard,
      syncTaskCard
    };
  }

  return { create, resultExplanationLabel };
});
