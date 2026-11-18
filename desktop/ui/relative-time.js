'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReaderRelativeTime = api;
})(typeof window === 'object' ? window : globalThis, function () {
  function relativeTime(value, now = Date.now()) {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    const seconds = Math.max(0, Math.floor((now - ms) / 1000));
    if (!Number.isFinite(ms)) return '时间未知';
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
    if (seconds < 2592000) return Math.floor(seconds / 86400) + ' 天前';
    if (seconds < 31536000) return Math.floor(seconds / 2592000) + ' 个月前';
    return Math.floor(seconds / 31536000) + ' 年前';
  }

  function timeSpan(node, value, text = relativeTime(value)) {
    const span = node('span', 'relative-time', text);
    span.dataset.timestamp = String(value);
    return span;
  }

  function refreshAll(all, now = Date.now()) {
    for (const span of all('.relative-time')) {
      const raw = span.dataset.timestamp;
      span.textContent = relativeTime(/^\d+$/.test(raw) ? Number(raw) : raw, now);
    }
  }

  return { relativeTime, timeSpan, refreshAll };
});
