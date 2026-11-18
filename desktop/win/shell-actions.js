'use strict';
// Single catalog for the Electron shell. Tests assert Win/Swift stay aligned.
const LOCAL_ACTIONS = new Set([
  'localInventory', 'localData', 'localExport', 'globalSearch', 'searchPage', 'searchOpen',
  'searchObjects', 'coverageTimeline', 'insightsCancel', 'taskGapIgnore', 'taskNoticeDismiss',
  'recoveryRetry', 'taskFuturePreview', 'taskFutureChoose', 'postAuthorAvatar'
]);
const ACCOUNT_ACTIONS = new Set(['loginCancel']);
const FORWARD_ACTIONS = new Set([
  'userNoteSave', 'postNoteSave', 'postAdd', 'postFavorite', 'userAdd', 'userViewed',
  'userProfileRetry', 'userProfileDismiss', 'userDeletePlan', 'userDeleteConfirm',
  'resumeTaskPreview', 'resumeTask', 'pricingReference', 'pricingRefresh', 'pricingQuote', 'manageBatch',
  'manageDeletePlan', 'manageDeleteConfirm', 'profilesRefresh', 'library', 'run', 'stop',
  'login', 'account', 'open', 'output', 'favorite', 'merge', 'updateHistory', 'retention',
  'cleanup', 'followList', 'followSave', 'followConfigure', 'followResume', 'followPause',
  'followRemove', 'followWake', 'exchangeObjects', 'exchangeCommit', 'exchangeDiscard',
  'nativeWorkspaceAccepted', 'frontendAttach', 'bootstrap', 'shutdown'
]);
const TRANSPORT_SAFE = new Set([
  'chooseDataExport', 'chooseDataImport', 'ready', 'stop', 'shutdown', 'copy', 'external',
  'taskFuturePreview', 'taskFutureChoose'
]);

function isKnownAction(action) {
  return LOCAL_ACTIONS.has(action) || ACCOUNT_ACTIONS.has(action) || FORWARD_ACTIONS.has(action) || TRANSPORT_SAFE.has(action);
}

module.exports = { LOCAL_ACTIONS, ACCOUNT_ACTIONS, FORWARD_ACTIONS, TRANSPORT_SAFE, isKnownAction };
