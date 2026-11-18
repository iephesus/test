'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReaderUserPicker = api;
})(typeof window === 'object' ? window : globalThis, function () {
  function create(deps) {
    const {
      getState, $, node, button, send, internal, closeAfterSelect, afterSelect, openUser
    } = deps;

    function close() {
      $('user-popover').hidden = true;
      $('choose-user').setAttribute('aria-expanded', 'false');
    }

    function toggleFavorite(uid) {
      if (uid) send({ action: 'favorite', uid, on: !getState().favorites.includes(uid) });
    }

    function selectUser(uid, report) {
      const state = getState();
      ReaderIdentity.selectUser(state, uid);
      if (state.busy) return;
      state.category = report?.category === 'posts' ? 'posts' : 'users';
      $('target').value = uid;
      state.updateOperation = 'regular';
      $('date-range-enabled').checked = !!report?.from;
      if (report?.mode && internal[report.mode] && report.category !== 'posts')
        $('mode').value = internal[report.mode];
      if (report?.count && !report.merged) {
        $('limit').value = report.count;
        $('unlimited').checked = false;
      }
      if (report?.from) {
        $('from').value = report.from;
        $('to').value = report.to;
      }
      $('history-recovery').checked = true;
      if (report?.database) {
        state.task = 'report';
        $('view-range-enabled').checked = !!report.from;
      }
      state.task = report?.database ? 'report' : 'sync';
      if (report?.merged) {
        $('limit').value = '50';
        $('unlimited').checked = false;
      }
      close();
      closeAfterSelect?.(uid, report);
      afterSelect?.(uid, report);
    }

    function renderFavorites() {
      const state = getState();
      const list = $('favorite-list');
      list.replaceChildren();
      const posts = state.postFavorites || [];
      $('favorite-count').textContent = state.favorites.length + posts.length;
      if (!state.favorites.length && !posts.length)
        list.append(node('p', 'favorite-empty', '在用户或博文旁点击 ☆，即可放在这里。'));
      for (const uid of state.favorites) {
        const u = window.userInfo?.(uid) || state.accounts.find(a => a.uid === uid) || { nickname: '用户 ' + uid };
        const pick = button('', 'favorite-pick', () => openUser(uid));
        pick.dataset.targetKind = 'user';
        pick.dataset.targetId = uid;
        pick.title = [u.nickname, 'UID ' + uid].join(' · ');
        pick.append(
          window.entityAvatar?.('user', uid, 'favorite-avatar') || node('span', 'favorite-avatar', Array.from(u.nickname || '')[0] || '微'),
          node('span', 'favorite-name', window.ReaderEntityActions?.displayName(u, u.nickname) || u.nickname)
        );
        list.append(pick);
      }
      for (const id of posts) {
        const post = (state.posts || []).find(p => p.postId === id);
        const pick = button('', 'favorite-pick', () => window.openPostPage?.(id));
        const original = post?.author ? post.author + ' · ' + (post.title || id) : post?.title || '微博 ' + id;
        const label = window.ReaderEntityActions?.displayName(post, original) || original;
        pick.dataset.targetKind = 'post';
        pick.dataset.targetId = id;
        pick.append(
          window.entityAvatar?.('post', id, 'favorite-avatar') || node('span', 'favorite-avatar', '▤'),
          node('span', 'favorite-name', label)
        );
        pick.title = original + ' · 微博 ID ' + id;
        list.append(pick);
      }
    }

    function render() {
      const state = getState();
      const term = $('user-search').value.normalize('NFKC').toLocaleLowerCase().trim();
      const users = state.accounts
        .filter(a => (!state.pickerFavorites || state.favorites.includes(a.uid)) && (!term || (a.nickname + ' ' + a.uid).normalize('NFKC').toLocaleLowerCase().includes(term)))
        .sort((a, b) => Number(state.favorites.includes(b.uid)) - Number(state.favorites.includes(a.uid)) || a.nickname.localeCompare(b.nickname, 'zh-CN'));
      const root = $('user-results');
      root.replaceChildren();
      $('picker-empty').hidden = users.length > 0;
      for (const user of users) {
        const row = node('div', 'user-option');
        const select = button('', 'user-option-pick', () => selectUser(user.uid));
        select.setAttribute('role', 'option');
        select.append(node('strong', '', user.nickname), node('span', '', user.uid));
        const star = button(state.favorites.includes(user.uid) ? '★' : '☆', 'user-star', () => toggleFavorite(user.uid));
        star.classList.toggle('selected', state.favorites.includes(user.uid));
        star.setAttribute('aria-label', (state.favorites.includes(user.uid) ? '取消特别关注' : '特别关注') + user.nickname);
        row.append(select, star);
        root.append(row);
      }
    }

    function open() {
      $('user-popover').hidden = false;
      $('choose-user').setAttribute('aria-expanded', 'true');
      render();
      $('user-search').focus();
    }

    function bind(all) {
      $('choose-user').addEventListener('click', () => { $('user-popover').hidden ? open() : close(); });
      $('user-search').addEventListener('input', render);
      $('picker-all').addEventListener('click', () => {
        getState().pickerFavorites = false;
        $('picker-all').classList.add('active');
        $('picker-favorites').classList.remove('active');
        render();
      });
      $('picker-favorites').addEventListener('click', () => {
        getState().pickerFavorites = true;
        $('picker-favorites').classList.add('active');
        $('picker-all').classList.remove('active');
        render();
      });
      $('favorite-target').addEventListener('click', () => toggleFavorite(deps.currentUser()));
      $('user-popover').addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          close();
          $('choose-user').focus();
          return;
        }
        const picks = all('.user-option-pick');
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const i = picks.indexOf(document.activeElement);
          const next = event.key === 'ArrowDown' ? Math.min(picks.length - 1, i + 1) : Math.max(0, i - 1);
          picks[next]?.focus();
        }
        if (event.key === 'Enter' && document.activeElement === $('user-search')) {
          event.preventDefault();
          picks[0]?.click();
        }
      });
      document.addEventListener('click', e => {
        if (!e.target.closest('.user-chooser')) close();
      });
    }

    return { close, open, render, renderFavorites, selectUser, toggleFavorite, bind };
  }

  return { create };
});
