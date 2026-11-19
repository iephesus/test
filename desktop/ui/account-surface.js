'use strict';
// Service-account login UI + balance / credits presentation (from app.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReaderAccountSurface = api;
})(typeof window === 'object' ? window : globalThis, function () {
  function serviceAccountText(account, numeric) {
    return (account.username ? '账户：' + account.username + '\n' : '')
      + '余额：' + (account.balance == null ? '暂不可用' : numeric(account.balance) + ' credits')
      + (account.service ? '\n服务状态：' + ({ formal_active: '正式服务', trial_active: '体验服务' }[account.service] || account.service) : '');
  }

  function create(deps) {
    const {
      state, $, serviceScope, taskEvents, send, view, setBusy, rememberFilters,
      toast, numeric, renderReturned
    } = deps;

    function serviceLoginBusy() {
      return !!state.serviceLogin && serviceScope.owns(state.serviceLogin)
        && taskEvents.snapshot().requestId === state.serviceLogin.requestId;
    }

    function contentTaskBusy() {
      return (state.busy || state.starting) && !serviceLoginBusy();
    }

    function renderServiceLogin() {
      const login = state.serviceLogin;
      const visible = !!login && (serviceScope.owns(login) || login.localOnly && !state.serviceWorkspaceAccepted);
      const box = $('service-login-status');
      box.hidden = !visible;
      if (!visible) return;
      $('service-login-heading').textContent = login.heading;
      globalThis.ReaderNotices?.reset($('service-login-message'));
      $('service-login-message').hidden = false;
      $('service-login-message').textContent = login.message;
      if (login.failed) {
        globalThis.ReaderNotices?.decorate($('service-login-message'), {
          scope: login.workspace + '|service-login',
          key: login.requestId || 'engine'
        });
      }
      $('service-login-cancel').hidden = !serviceLoginBusy();
      $('service-login-cancel').disabled = !!login.cancelling;
    }

    function serviceLoginEvent(event, ownership) {
      const login = state.serviceLogin;
      if (!login || !serviceScope.owns(login)) return false;
      const engineStopped = ['engineStopped', 'engineTransportError'].includes(event.type)
        && ownership.task?.requestId === login.requestId;
      if (!engineStopped && (ownership.route !== 'task' || ownership.task?.requestId !== login.requestId)) return false;
      if (engineStopped) {
        state.engineAvailable = false;
        login.failed = true;
        login.heading = '登录已中断';
        login.message = '运行引擎已停止，请重新打开应用后登录；未读取微博内容。';
      } else if (event.type === 'started' || event.type === 'preparing') {
        login.heading = event.type === 'started' ? '等待浏览器授权' : '准备登录';
        login.message = event.type === 'started'
          ? '请在服务提供方的浏览器页面完成登录授权，不会读取微博内容。'
          : '正在准备服务账户登录，不会读取微博内容。';
      } else if (event.type === 'stopping') {
        login.cancelling = true;
        login.heading = '正在取消登录';
        login.message = '正在等待登录进程退出，不会开始读取微博内容。';
      } else if (event.type === 'error') {
        login.failed = true;
        login.heading = '登录未完成';
        login.message = event.message || '登录未完成，请稍后重试。';
      } else if (event.type === 'finished') {
        login.cancelling = false;
        login.failed = !event.cancelled && event.code !== 0;
        login.heading = event.cancelled ? '已取消登录' : event.code === 0 ? '授权已完成' : '登录未完成';
        login.message = event.cancelled
          ? '本次登录已取消，未读取微博内容。'
          : event.code === 0
            ? '浏览器授权已完成，正在核对服务账户与余额。'
            : '服务账户登录未完成，请重试；未读取微博内容。';
      }
      setBusy({ accountOnly: true });
      renderServiceLogin();
      if (event.type === 'finished' && event.code === 0 && !event.cancelled) {
        send({ action: 'account', loginRequestId: login.requestId });
      }
      return true;
    }

    function topBalance(value, note = '', unknown = '暂不可用') {
      state.displayBalance = value;
      $('top-balance').textContent = value == null ? unknown : numeric(value) + ' credits';
      $('top-balance-note').textContent = note;
      $('top-balance').classList.toggle('zero', value === 0);
    }

    function credits(data) {
      state.credits = data;
      $('cost').textContent = data.estimatedCredits == null ? '待核对' : numeric(data.estimatedCredits);
      $('cost').classList.toggle('uncertain', data.estimatedCredits == null || data.unknownRequests > 0);
      if (data.unknownRequests > 0) {
        $('cost').textContent = (data.estimatedCredits == null ? '' : numeric(data.estimatedCredits) + ' + ') + '待核对';
      }
      let balance = null;
      let label = '剩余余额';
      if (data.finalBalance != null) {
        balance = data.finalBalance;
        label = '服务端查询余额';
        state.account = { ...state.account, balance, checkedAt: Date.now() };
        topBalance(balance, '已核实');
      } else if (data.initialBalance != null && !data.unknownRequests && data.estimatedCredits != null) {
        balance = data.initialBalance - data.estimatedCredits;
        label = '余额估算';
        topBalance(balance, '估算');
      } else if (!data.offline && state.jobBalance != null && !data.unknownRequests && data.estimatedCredits != null) {
        balance = state.jobBalance - data.estimatedCredits;
        label = '余额估算';
        topBalance(balance, '估算');
      } else if (state.account?.balance != null) {
        balance = state.account.balance;
        label = '上次查询余额';
        if (data.unknownRequests) topBalance(balance, '上次查询 · 费用待核对');
      }
      $('balance-label').textContent = label;
      $('balance').textContent = balance == null
        ? (data.offline ? '离线，未查询' : '暂不可用')
        : numeric(balance) + ' credits';
      renderReturned(data);
    }

    function beginLoginSend(value) {
      if (!state.serviceWorkspaceAccepted) {
        state.serviceLogin = {
          localOnly: true,
          heading: '登录尚未开始',
          message: '正在准备本地资料目录，请稍后再登录；未发起登录或内容请求。'
        };
        view('settings');
        renderServiceLogin();
        return null;
      }
      if (state.engineAvailable === false) {
        state.serviceLogin = serviceScope.capture({
          failed: true,
          heading: '登录未启动',
          message: '运行引擎已停止，请重新打开应用后登录；未读取微博内容。'
        });
        view('settings');
        renderServiceLogin();
        return null;
      }
      const requestId = crypto.randomUUID();
      if (!taskEvents.begin(requestId, null)) {
        toast('请先等待或停止当前任务。');
        return null;
      }
      rememberFilters();
      state.serviceAccountRequest = null;
      state.balanceQueryState = 'idle';
      topBalance(state.displayBalance ?? null, state.displayBalance == null ? '' : '上次查询值', '尚未查询');
      if (state.account) {
        $('account-info').textContent = '上次查询结果（本次授权后尚未核实）：\n' + serviceAccountText(state.account, numeric);
      }
      globalThis.ReaderSettingsStatus?.serviceAccount(null, 'authorization');
      state.serviceLogin = serviceScope.capture({
        requestId,
        heading: '准备登录',
        message: '正在准备服务账户登录，不会读取微博内容。'
      });
      view('settings');
      setBusy({ accountOnly: true });
      renderServiceLogin();
      return { ...value, requestId };
    }

    function beginAccountSend(value) {
      if (!state.serviceWorkspaceAccepted) return null;
      value = { ...value, requestId: crypto.randomUUID() };
      state.serviceAccountRequest = serviceScope.capture({
        requestId: value.requestId,
        loginRequestId: value.loginRequestId
      });
      state.balanceQueryState = 'loading';
      $('refresh-balance').disabled = true;
      $('check-account').disabled = true;
      topBalance(state.displayBalance ?? null, state.displayBalance == null ? '' : '查询中…', '查询中…');
      return value;
    }

    return {
      serviceLoginBusy,
      contentTaskBusy,
      serviceAccountText: account => serviceAccountText(account, numeric),
      renderServiceLogin,
      serviceLoginEvent,
      topBalance,
      credits,
      beginLoginSend,
      beginAccountSend
    };
  }

  return { create, serviceAccountText };
});
