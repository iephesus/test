'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window === 'object' ? window : globalThis, function () {
  const modes = {
    'comments-both': '发出和收到的评论',
    'comments-sent': '发出的评论',
    'comments-received': '收到的评论',
    'mentions-in-comments': '被 @ 的评论',
    'mentions-in-posts': '被 @ 的微博',
    'comments-and-mentions': '评论与 @',
    'post-comments': '微博下的评论',
    'user-posts': '用户微博'
  };
  const internal = {
    sent: 'comments-sent',
    received: 'comments-received',
    both: 'comments-both',
    'mentions-comments': 'mentions-in-comments',
    'mentions-posts': 'mentions-in-posts',
    'post-comments': 'post-comments',
    'user-posts': 'user-posts'
  };
  const policies = {
    update: '更新新记录',
    cache: '读取历史记录',
    refresh: '读取记录 · 重新核查',
    offline: '用本地数据生成',
    database: '用本地数据生成'
  };
  const categories = {
    'user-comments': '用户互动',
    'post-comments': '微博评论',
    posts: '用户微博'
  };
  function modeLabel(value) {
    return modes[internal[value] || value] || value || '';
  }
  return { modes, internal, policies, categories, modeLabel };
});
