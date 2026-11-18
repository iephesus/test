'use strict';
// One interpretation of collection state for filenames, reports, events and audits.
// Reaching an API end is separate from fulfilling a quota or knowing every date/body.
function collectionResult(source={}){
 const budget=source.budget,requested=budget>0,unknownTimeIds=[...new Set(source.unknownTimeIds||[])];
 const failed=!!source.failed,unverified=!!source.coverageUnverified||unknownTimeIds.length>0||Number.isFinite(source.beforeMs)&&!source.located;
 const capped=!source.autoFollow&&!source.incremental&&(!!source.returnLimited||!!source.update?.limited||!source.quickOnly&&requested&&source.fetched<budget&&!source.ended);
 const pending=!!source.update&&!source.update.caughtUp||!!source.resumePending||!!source.pendingNew||!!source.readProgress?.pending;
 const replies=!!source.incompleteReplies?.length;
 const optionalHistory=source.source==='crawler'&&!source.incremental&&source.readProgress?.targetCovered===true&&source.readProgress.historyPending===true;
 const postIncomplete=source.kind==='post-comments'&&(replies||(source.incremental?source.complete!==true:!optionalHistory&&(!source.ended||source.complete===false)));
 const incomplete=!!(requested&&(source.cancelled||source.partial||source.resumePending||failed||unverified||capped||pending||postIncomplete));
 const progress=source.readProgress||{},targetCovered=typeof progress.targetCovered==='boolean'?progress.targetCovered:requested&&source.fetched>=budget,
  pendingNew=typeof progress.pendingNew==='boolean'?progress.pendingNew:source.pendingNew===true||!!source.update&&!source.update.caughtUp,
  deltaConnected=typeof progress.deltaConnected==='boolean'?progress.deltaConnected:source.update?!!source.update.caughtUp:null,
  missingBodies=source.completeness?.missingKnownIds||source.missingBodyIds?.length||0;
 const dataState=source.running?'running':source.cancelled?'interrupted':failed?'failed':pendingNew?'continuation':source.returnLimited||source.update?.limited?'budget-stopped':missingBodies?'historical-missing':unverified?'unverified':source.update?.caughtUp&&source.update?.newCount===0?'no-new':incomplete?'unfinished':'covered';

 return {dataState,targetCovered,pendingNew,deltaConnected,status:!requested?'idle':source.cancelled?'interrupted':failed?'failed':unverified?'unverified':pending||postIncomplete?'unfinished':capped?'capped':source.ended?'exhausted':'fulfilled',incomplete,ended:!!source.ended,quotaReached:requested&&source.fetched>=budget,failed,coverageUnverified:!!unverified,unknownTimeIds,missingBodies,...(source.unknownMissing?{unknownMissing:true}:{}),...(source.progressConflict?{progressConflict:true}:{}),...(source.requestFailure?{requestFailure:source.requestFailure}:{}),reason:source.reason||''};
}
module.exports={collectionResult};
