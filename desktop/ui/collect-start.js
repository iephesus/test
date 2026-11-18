'use strict';
// Paid sync start gate: quote once, confirm once, then launch. Pure helpers are
// exportable for tests; create() owns the pending quote request.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReaderCollectStart = api;
})(typeof window === 'object' ? window : globalThis, function () {
  function shouldConfirmPaidStart(preview, input) {
    return !preview && !!input?.syncOnly && !['offline', 'database'].includes(input.policy);
  }

  function replaceTargetLabel(message, targetLabel) {
    if (!message) return '确认后才会开始联网取数。';
    return String(message).replace(/^目标：.*$/m, '目标：' + targetLabel);
  }

  function targetLabelForQuery(input, { category, currentTarget, currentUser, accounts, userInfo, postId } = {}) {
    if (input?.mode === 'post-comments' || category === 'post') {
      const id = postId?.(input?.target || currentTarget?.()) || '';
      return id ? '博文 ' + id : '当前博文';
    }
    const uid = input?.uid || currentUser?.() || '';
    const nickname = userInfo?.(uid)?.nickname || accounts?.()?.find(a => a.uid === uid)?.nickname;
    return (nickname ? nickname + ' · ' : '') + 'UID ' + (uid || '当前用户');
  }

  function create(deps) {
    let pricingConfirm = null;
    const {
      getState,
      send,
      toast,
      validate,
      buildQuery,
      beginLaunch,
      confirm,
      field,
      all,
      notice,
      postId,
      userInfo
    } = deps;

    function clear() { pricingConfirm = null; }
    function isPending() { return !!pricingConfirm; }

    function labelFor(input) {
      const state = getState();
      return targetLabelForQuery(input, {
        category: state.category,
        currentTarget: () => (deps.currentTarget ? deps.currentTarget() : ''),
        currentUser: () => (deps.currentUser ? deps.currentUser() : ''),
        accounts: () => state.accounts,
        userInfo,
        postId
      });
    }

    function newId() {
      return typeof deps.uuid === 'function' ? deps.uuid() : crypto.randomUUID();
    }

    function requestQuote(input) {
      if (pricingConfirm) return;
      const requestId = newId();
      pricingConfirm = { requestId, input: JSON.parse(JSON.stringify(input)), workspace: getState().workspace };
      toast('正在查询本次任务费用…');
      send({ action: 'pricingQuote', requestId, query: pricingConfirm.input });
    }

    function receive(event) {
      const pending = pricingConfirm;
      if (event.type === 'error' && pending && event.requestId === pending.requestId) {
        pricingConfirm = null;
        toast(event.message || '本次任务费用查询未完成，未开始取数。', true);
        return true;
      }
      if (!['pricingQuote', 'pricingQuoteError'].includes(event.type)) return false;
      if (!pending || event.requestId !== pending.requestId) return !!pending;
      pricingConfirm = null;
      if (event.type === 'pricingQuoteError') {
        toast(event.message || '本次任务费用查询未完成，未开始取数。', true);
        return true;
      }
      const state = getState();
      if (pending.workspace !== state.workspace || state.busy || state.starting) {
        toast('任务状态已变化，未开始取数。');
        return true;
      }
      const body = replaceTargetLabel(event.message, labelFor(pending.input));
      Promise.resolve(confirm('确认开始本次获取？', body, '确认开始')).then(ok => {
        if (!ok || pending.workspace !== getState().workspace || getState().busy || getState().starting) return;
        beginLaunch(pending.input);
      });
      return true;
    }

    function onLibrary(event) {
      if (pricingConfirm && event.workspace && event.workspace !== pricingConfirm.workspace) clear();
    }

    function start(preview) {
      const state = getState();
      if (state.engineAvailable === false) {
        toast('运行引擎已停止，请重新打开应用后重试。', true);
        return;
      }
      if (state.task === 'report') {
        deps.exportLocal?.();
        return;
      }
      if (state.busy || state.starting) return;
      if (pricingConfirm) {
        toast('仍在查询本次任务费用，请稍候…');
        return;
      }
      field('form-error').hidden = true;
      all('[aria-invalid=true]').forEach(el => el.removeAttribute('aria-invalid'));
      const input = buildQuery(preview);
      const error = validate(input);
      if (error) {
        const formError = field('form-error');
        formError.textContent = error.message;
        formError.hidden = false;
        notice?.(formError, { key: 'validation:' + newId() });
        const node = field(error.field);
        node.setAttribute('aria-invalid', 'true');
        const advanced = node.closest('details');
        if (advanced) advanced.open = true;
        node.focus();
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (shouldConfirmPaidStart(preview, input)) {
        requestQuote(input);
        return;
      }
      beginLaunch(input);
    }

    return { clear, isPending, start, receive, onLibrary, onEngineDown: clear };
  }

  return { shouldConfirmPaidStart, replaceTargetLabel, targetLabelForQuery, create };
});
