(function (root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = factory();
 else root.ReaderWorkspaceChannel = factory();
})(typeof window === 'object' ? window : globalThis, function () {
 'use strict';
 // The accepted library snapshot owns workspace readiness. Optional services
 // must be notified after the identity changes, never before initialization.
 function create({ current, assign, ready }) {
  function bind(message) {
   return { ...message, ...(current() ? { workspace: current() } : {}) };
  }
  function accept(event) {
   return !event.workspace || !current() || event.workspace === current() || event.type === 'library';
  }
  function library(event) {
   if (event.type !== 'library' || typeof event.workspace !== 'string' || !event.workspace) throw Error('资料目录响应缺少身份');
   assign(event.workspace);
   ready?.();
  }
  return { bind, accept, library };
 }
 // Dialogs can outlive an accepted library change, including A → B → A.
 // Observe the library event before the main controller assigns its workspace.
 function createScope(current) {
  let workspace = current() || '', generation = 0;
  function observe(event) {
   if (event.type !== 'library' || !event.workspace || event.workspace === workspace) return false;
   workspace = event.workspace; generation += 1; return true;
  }
  function capture(value = {}) { return { ...value, workspace: current() || '', generation }; }
  function owns(value, event) {
   return !!value?.workspace && value.workspace === workspace && value.workspace === current() &&
    value.generation === generation && (!event?.workspace || event.workspace === value.workspace);
  }
  return { observe, capture, owns };
 }
 return { create, createScope };
});
