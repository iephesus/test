'use strict';
// Home list loading / unread projection / startup paint — extracted from app.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReaderHomeSurface = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const HOME_SECTIONS = ['users', 'posts', 'reports', 'subscriptions'];
  const HOME_PAYLOAD = {
    homeUsers: 'users',
    postsHome: 'posts',
    libraryData: 'reports',
    followState: 'subscriptions'
  };

  function create(deps) {
    const { state, send, $, node, button, getHomeSnapshots, getHistoryView } = deps;
    const ownerUnread = new Map();
    let startupPaintQueued = false;

    function renderHomeLoadStatus(section, id, retry = () => send({ action: 'library' })) {
      const value = state.homeLoading[section] || { status: 'ready' };
      const box = $(id);
      if (!box) return value.status;
      box.hidden = value.status === 'ready';
      box.replaceChildren();
      box.setAttribute('role', value.status === 'error' ? 'alert' : 'status');
      const subject = { users: '用户', posts: '博文', subscriptions: '订阅' }[section] || '资料';
      if (!box.hidden) {
        box.append(node('span', '', value.status === 'error'
          ? '本地列表未能读取：' + (value.message || '请重试')
          : '正在读取本地' + subject + '数据…'));
        if (value.status === 'error') box.append(button('重试读取', 'button secondary', retry));
      }
      return value.status;
    }

    function noteStartupList() {
      if (startupPaintQueued || !globalThis.webkit?.messageHandlers?.weibo) return;
      const workspace = state.workspace;
      startupPaintQueued = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (workspace !== state.workspace) {
          startupPaintQueued = false;
          noteStartupList();
          return;
        }
        const home = $('view-home');
        const empty = !state.accounts.length && state.homeLoading.users.status === 'ready';
        if (!home.hidden && ($('home-users').querySelector('.user-open:not([disabled])') || empty)) {
          send({ action: 'startupListReady' });
        } else {
          startupPaintQueued = false;
        }
      }));
    }

    function syncOwnerUnread(event) {
      const changed = new Set();
      const revision = Number.isSafeInteger(event.readingRevision) ? event.readingRevision : 0;
      function storeUnread(kind, id, count, unavailable, write, rowRevision = revision) {
        if (typeof id !== 'string' || !/^[1-9]\d{4,19}$/.test(id) || !Number.isSafeInteger(count) && count !== null && !unavailable) return;
        const key = kind + ':' + id;
        const previous = ownerUnread.get(key);
        if (previous && rowRevision < previous.revision) {
          write(previous);
          return;
        }
        const value = { count, unavailable: !!unavailable, revision: rowRevision };
        ownerUnread.set(key, value);
        if (!previous || previous.count !== value.count || previous.unavailable !== value.unavailable) changed.add(key);
      }
      const home = (kind, row) => storeUnread(kind, kind === 'post' ? row.postId : row.uid, row.unread, row.unreadUnavailable, value => {
        row.unread = value.count;
        row.unreadUnavailable = value.unavailable;
      }, Number.isSafeInteger(row.readingRevision) ? row.readingRevision : revision);
      const follow = row => storeUnread(row.targetKind || 'user', row.postId || row.uid, row.inbox?.unread, row.inbox?.unavailable, value => {
        row.inbox = { ...row.inbox, unread: value.count, unavailable: value.unavailable };
      });
      if (event.type === 'homeUsers') for (const row of event.users || []) home('user', row);
      if (event.type === 'postsHome') for (const row of event.posts || []) home('post', row);
      if (event.type === 'followState') for (const row of event.entries || []) follow(row);
      if (event.type === 'reportMarkedRead') {
        const kind = event.targetKind === 'post' ? 'post' : 'user';
        const id = kind === 'post' ? event.postId : event.uid;
        if (Number.isSafeInteger(event.unread) && event.unread >= 0) storeUnread(kind, id, event.unread, false, () => {});
      }
      if (!changed.size) return changed;
      for (const [kind, rows] of [['user', state.homeUsers], ['post', state.posts]]) {
        for (const row of rows || []) {
          const key = kind + ':' + (kind === 'post' ? row.postId : row.uid);
          const value = ownerUnread.get(key);
          if (changed.has(key)) {
            row.unread = value.count;
            row.unreadUnavailable = value.unavailable;
          }
        }
      }
      for (const row of state.subscriptions || []) {
        const key = (row.targetKind || 'user') + ':' + (row.postId || row.uid);
        const value = ownerUnread.get(key);
        if (changed.has(key)) row.inbox = { ...row.inbox, unread: value.count, unavailable: value.unavailable };
      }
      return changed;
    }

    function retainsHomeSnapshot(event) {
      return !!(event.partial && state.workspace && state.workspace === event.workspace && !event.homeBlocked && !state.homeBlocked);
    }

    function homeLoadEvent(event, retain) {
      if (event.type === 'library') {
        const clear = state.workspace !== event.workspace || event.homeBlocked;
        if (clear || state.bootstrapId !== event.bootstrapId) {
          getHomeSnapshots()?.reset();
          getHistoryView()?.reset();
        }
        if (clear) {
          ownerUnread.clear();
          state.homeUsers = [];
          state.posts = [];
          state.postAuthors = {};
          state.database = [];
          state.reports = [];
          state.homeAssetSnapshots = {};
        }
        state.bootstrapId = event.bootstrapId;
        state.homeBlocked = !!event.homeBlocked;
        state.homeLoading = Object.fromEntries(HOME_SECTIONS.map(name => [name, retain && state.homeLoading[name]?.snapshot ? state.homeLoading[name] : {
          status: event.partial ? 'loading' : 'ready',
          snapshot: !event.partial && name === 'reports' && Object.hasOwn(event, 'reports')
        }]));
      } else if (event.bootstrapId && event.bootstrapId !== state.bootstrapId || state.homeBlocked && HOME_PAYLOAD[event.type]) {
        return false;
      }
      if (event.type === 'libraryState') {
        const renders = { users: globalThis.renderUserHome, posts: globalThis.renderPostHome, reports: globalThis.renderContextReports };
        for (const name of event.section === 'all' ? HOME_SECTIONS : [event.section]) {
          if (!HOME_SECTIONS.includes(name)) continue;
          const previous = state.homeLoading[name];
          const snapshot = !!previous?.snapshot;
          if (snapshot && event.status === 'loading' || previous?.snapshotFailed && event.status === 'ready') continue;
          const next = {
            status: event.status,
            message: event.message || '',
            snapshot,
            ...(event.snapshotFailed ? { snapshotFailed: true } : {})
          };
          if (previous?.status === next.status && (previous?.message || '') === next.message && previous?.snapshotFailed === next.snapshotFailed) continue;
          state.homeLoading[name] = next;
          renders[name]?.();
        }
      } else if (HOME_PAYLOAD[event.type]) {
        state.homeLoading[HOME_PAYLOAD[event.type]] = { status: 'ready', snapshot: true };
      }
      return true;
    }

    return {
      homeSections: HOME_SECTIONS,
      homePayload: HOME_PAYLOAD,
      ownerUnread,
      renderHomeLoadStatus,
      noteStartupList,
      syncOwnerUnread,
      retainsHomeSnapshot,
      homeLoadEvent
    };
  }

  return { create, HOME_SECTIONS, HOME_PAYLOAD };
});
