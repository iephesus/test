'use strict';
// Transient page feedback is scoped by typed object identity, never the visible form
// of a running job. Durable acquisition/fee history remains in the data directory.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./form-utils'),require('./acquisition-feedback'));else root.ReaderTaskActivity=factory(root.ReaderUX,root.ReaderAcquisitionFeedback);})(globalThis,(ux,feedback)=>{
 function key(query,workspace=''){if(!query)return '';const post=query.subject?.kind==='post'||query.mode==='post-comments',id=post?ux.postId(query.subject?.id||query.target):ux.uid(query.subject?.uid||query.target);return id?workspace+'|'+(post?'post:':'user:')+id:'';}
 const clone=value=>value==null?null:JSON.parse(JSON.stringify(value));
 const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,clone(v[k])]));
 const missingIds=ids=>new Set(ids.filter(id=>typeof id==='string'&&/^[1-9]\d*$/.test(id)));
 function missingBodies(issues,byKind=new Map()){
  const ids=new Set();
  for(const [kind,values] of byKind){
   const type=kind==='mentions-posts'||kind==='user-posts'?'post:':'comment:';
   for(const id of values)ids.add(type+id);
  }
  let count=ids.size,possible=count;
  for(const issue of issues){
   if(!issue.missingBodyCount)continue;
   const known=byKind.get(issue.code.slice('missing:'.length))?.size||0;
   count=Math.max(count,issue.missingBodyCount);
   possible+=Math.max(0,issue.missingBodyCount-known);
  }
  return {count,atLeast:possible>count};
 }
 function create(){const entries=new Map();
  function entry(q,workspace,make=false){const id=key(q,workspace);if(!id)return null;let value=entries.get(id);if(!value&&make){value={logs:[],summary:null,outcome:null};entries.set(id,value);}if(value){entries.delete(id);entries.set(id,value);}while(entries.size>32)entries.delete(entries.keys().next().value);return value;}
  function append(q,text,workspace=''){const value=entry(q,workspace,true);if(!value||!text)return;value.logs.push(String(text).slice(0,2000));if(value.logs.length>1000)value.logs.splice(0,value.logs.length-1000);let total=[...entries.values()].reduce((n,e)=>n+e.logs.length,0);for(const e of entries.values()){if(total<=8000)break;const cut=Math.min(e.logs.length,total-8000);e.logs.splice(0,cut);total-=cut;}}
  function receive(event,q,workspace=''){const value=entry(q,workspace,true);if(!value)return;const taskId=event.taskId||event.id;if(event.type==='started'&&event.kind==='collect'){Object.assign(value,{taskId,query:clone(q),logs:[],summary:null,outcome:null,result:null,credits:null,resultSummary:null,preview:!!q.preview,missingByKind:new Map()});return;}if(value.taskId&&taskId&&value.taskId!==taskId)return;
   if(event.type==='source'){
    const observed=event.availability?.missingBodyIds,durable=event.missingBodyIds;
    if(Array.isArray(observed)||Array.isArray(durable))value.missingByKind?.set(event.kind,missingIds([...(observed||[]),...(durable||[])]));
   }
   if(event.type==='credits')value.credits=pick(event,['estimatedCredits','returnedRecords','unknownRequests','initialBalance','finalBalance','offline','source']);
   if(event.type==='summary'){value.resultSummary=pick(event,['syncOnly','records','addedRecords','reusedRecords','newRecords','apiCalls','cachedCalls','incomplete','cancelled','updatedAt','persistence','batchId','sources','partialFailures','historicalMissingIds','inventoryRepair','source']);value.resultSummary.mode=q.mode;value.summary={saved:!!event.syncOnly,records:event.records||0,addedRecords:event.addedRecords,incomplete:!!event.incomplete,cancelled:!!event.cancelled,pending:(event.sources||[]).some(s=>s.dataStatus?.pendingNew||s.readProgress?.pendingNew)};}
   if(event.type==='finished'&&event.kind==='collect'&&!event.preview&&!value.preview){const s=value.summary||{},cancelled=!!event.cancelled||s.cancelled,failed=event.code!=null&&event.code!==0||event.coreFailed,warning=event.partial||s.incomplete||event.partialFailures?.length;value.outcome={state:cancelled?'interrupted':failed?'failed':!s.saved?'unverified':warning?'partial':'complete',records:s.records||0,addedRecords:s.addedRecords,pending:!!s.pending,coreFailed:!!event.coreFailed,partialFailures:(event.partialFailures||[]).slice(0,20).map(f=>({stage:String(f.stage||'后续处理').slice(0,100),message:String(f.message||'').slice(0,1000)})),at:Number.isFinite(Date.parse(event.finishedAt))?Date.parse(event.finishedAt):Date.now()};value.outcome.feedback=feedback.describe(value.resultSummary||{},event);if(!value.outcome.feedback.saved&&!['failed','interrupted'].includes(value.outcome.state))value.outcome.state='unverified';if(value.query?.syncOnly||s.saved)value.result={taskId:value.taskId,query:clone(value.query),summary:clone(value.resultSummary),credits:clone(value.credits),outcome:clone(value.outcome),missingBodies:missingBodies(value.outcome.feedback.issues,value.missingByKind??undefined)};value.missingByKind=null;}
  }
  function hydrate(task,workspace=''){
   const q=task?.query;if(!q||q.preview||!task.summary?.syncOnly||!Number.isFinite(Date.parse(task.finishedAt||task.summary.updatedAt))||!['complete','partial','interrupted','failed'].includes(task.status)||entry(q,workspace)?.taskId)return;
   receive({type:'started',kind:'collect',taskId:task.id},q,workspace);
   if(task.credits||task.summary.billing)receive({type:'credits',taskId:task.id,...(task.credits||task.summary.billing)},q,workspace);
   receive({...task.summary,type:'summary',taskId:task.id},q,workspace);
   receive({type:'finished',kind:'collect',taskId:task.id,code:task.status==='failed'?1:0,cancelled:task.status==='interrupted',partial:task.status==='partial',finishedAt:task.finishedAt||task.summary.updatedAt},q,workspace);
  }
  function resolvePending(taskId,workspace=''){
   let changed=false;for(const [id,value]of entries){if(!id.startsWith(workspace+'|')||value.result?.taskId!==taskId||!value.result.outcome.pending)continue;value.result.outcome.pending=false;const summary=value.result.summary||{};for(const source of summary.sources||[]){if(source.update){source.update.caughtUp=true;source.update.pending=false;}if(source.readProgress){source.readProgress.deltaConnected=true;source.readProgress.pending=false;source.readProgress.pendingNew=false;}if(source.dataStatus){source.dataStatus.pendingNew=false;source.dataStatus.deltaConnected=true;}}if(summary.sources?.length)summary.incomplete=summary.sources.some(s=>s.failed||s.cancelled||s.coverageUnverified||s.dataStatus?.coverageUnverified);value.result.outcome.feedback=feedback.describe(summary,{partialFailures:value.result.outcome.partialFailures});if(value.taskId===taskId&&value.outcome){value.outcome.pending=false;value.outcome.feedback=clone(value.result.outcome.feedback);}changed=true;}return changed;
  }
  return {append,receive,hydrate,resolvePending,lines:(q,w='')=>[...(entry(q,w)?.logs||[])],outcome:(q,w='')=>{const value=entry(q,w),o=value?.outcome;return o&&(!value.query?.mode||!q?.mode||value.query.mode===q.mode)?{...o}:null;},result:(q,w='')=>{const r=entry(q,w)?.result;return r&&r.query?.mode===q?.mode?clone(r):null;},forget:(q,w='')=>entries.delete(key(q,w))};
 }
 return {create,key};
});
