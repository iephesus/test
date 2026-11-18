'use strict';
// One persisted automatic cadence. Recovery/protection clocks remain separate.
const steps=Object.freeze([1,3,5,10,15,30]),POLICY=1;
const frequencyEventTriggers=Object.freeze(['sent','received','any']),frequencyEventReasons=Object.freeze(['activity','no-new','incomplete','unobserved','failed','baseline','replay','history']);
function trigger(entry){return entry.mode==='post-comments'?'post-comments':entry.mode==='sent'||entry.mode==='received'?entry.mode:['sent','received','any'].includes(entry.accelerationTrigger)?entry.accelerationTrigger:'sent';}
function settingsKey(entry){return JSON.stringify([entry.targetKind||'user',entry.mode,entry.frequency,entry.frequency==='fixed'?entry.interval:null,entry.targetKind==='post'?[entry.source||'cli','']:entry.accelerationTrigger||'sent']);}
function cadence(value){return steps.find(n=>n>=Number(value))||30;}
function normalize(entry,at){
 delete entry.profile;if(entry.frequency!=='adaptive')return entry;
 const legacy=entry.adaptivePolicyVersion!==POLICY,old=Number(entry.effectiveInterval);
 entry.effectiveInterval=Number.isFinite(old)&&old>0?cadence(old):1;
 entry.quietChecks=legacy?0:Math.min(1,Math.max(0,Number.isSafeInteger(entry.quietChecks)?entry.quietChecks:0));entry.adaptivePolicyVersion=POLICY;
 if(legacy&&old>30){
  const ordinary=entry.status==='waiting'&&!entry.recovery&&!entry.pauseCode&&!(Number(entry.restUntil)>at);
  if(ordinary&&Number.isFinite(Date.parse(entry.nextCheckAt))){const last=Date.parse(entry.lastCheckAt),deadline=(Number.isFinite(last)?last:at)+30*60000;entry.nextCheckAt=new Date(Math.min(Date.parse(entry.nextCheckAt),Math.max(at,deadline))).toISOString();}
  for(const slot of Object.values(entry.directionRetry||{}))if(slot?.attempts===0&&!slot.code&&Number.isFinite(Date.parse(slot.nextRetryAt))){const last=Date.parse(slot.lastAttemptAt),deadline=(Number.isFinite(last)?last:at)+30*60000;slot.nextRetryAt=new Date(Math.min(Date.parse(slot.nextRetryAt),Math.max(at,deadline))).toISOString();}
 }
 return entry;
}
function applicable(entry){const selected=trigger(entry);return selected==='any'?['sent','received']:[selected];}
function fresh(source){return (Number.isFinite(source.requests)&&source.requests>(source.cachedCalls||0));}
function baseline(source){return source.baselineOnly||source.update?.initialized||source.update?.resumed;}
function latestComplete(source){
 if(baseline(source)||source.cancelled||source.returnLimited||!fresh(source))return false;
 if(source.update?.protection)return source.update.protection.latestComplete===true;
 return !source.failed&&!source.dataStatus?.failed&&!source.dataStatus?.incomplete&&!source.coverageUnverified&&source.update?.caughtUp===true&&!source.readProgress?.pending;
}
function hasActivity(entry,summary,at){
 if(!summary||summary.from||summary.to)return false;const kinds=applicable(entry),recent=Math.max(10,entry.effectiveInterval||1)*60000;
 return (summary.sources||[]).some(s=>kinds.includes(s.kind)&&fresh(s)&&!s.baselineOnly&&!s.update?.initialized&&Number.isSafeInteger(s.newIndependentCount)&&s.newIndependentCount>0&&Number.isFinite(s.latestIndependentActivityMs)&&s.latestIndependentActivityMs>0&&s.latestIndependentActivityMs>=at-recent&&s.latestIndependentActivityMs<=at+60000);
}
function interval(entry,summary,at,decision){
 if(entry.frequency!=='adaptive')return entry.interval;normalize(entry,at);const current=entry.effectiveInterval,beforeQuiet=entry.quietChecks,selected=trigger(entry),done=reason=>{decision?.({beforeMinutes:current,afterMinutes:entry.effectiveInterval,beforeQuiet,afterQuiet:entry.quietChecks,trigger:selected==='post-comments'?'any':selected,reason});return entry.effectiveInterval;};
 if(!summary)return done('unobserved');if(summary.from||summary.to)return done('history');
 const kinds=applicable(entry),sources=(summary.sources||[]).filter(s=>kinds.includes(s.kind)),active=hasActivity(entry,summary,at);
 if(active){entry.lastActiveAt=at;entry.quietChecks=0;entry.effectiveInterval=1;return done('activity');}
 const quiet=!summary.cancelled&&kinds.every(kind=>{const s=sources.find(s=>s.kind===kind);return s&&latestComplete(s)&&s.newIndependentCount===0&&(s.savedIndependentCount??s.newIndependentCount)===0;});
 if(quiet){entry.quietChecks++;if(entry.quietChecks===2){entry.effectiveInterval=steps[Math.min(steps.length-1,steps.indexOf(current)+1)];entry.quietChecks=0;}}
 else if(sources.some(s=>fresh(s)&&!baseline(s)))entry.quietChecks=0;
 return done(quiet?'no-new':!sources.length?'unobserved':sources.some(s=>s.baselineOnly||s.update?.initialized)?'baseline':sources.every(s=>!fresh(s))?'replay':sources.some(s=>s.failed||s.cancelled||s.dataStatus?.failed)||summary.cancelled?'failed':'incomplete');
}
module.exports={steps,POLICY,frequencyEventTriggers,frequencyEventReasons,trigger,settingsKey,normalize,latestComplete,hasActivity,interval};
