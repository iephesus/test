'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readerRoot}=require('../lib/data-layout'),{atomic}=require('../lib/update-progress');
const read=(file,fallback)=>{try{return require('../lib/file-view-cache').readJSON(file);}catch(error){if(error.code==='ENOENT')return fallback;throw Error('本地用户或任务状态无法读取，原文件保留：'+path.basename(file),{cause:error});}},registry=base=>path.join(readerRoot(base),'users.json'),taskFile=(base,id)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('原任务编号无效');return path.join(readerRoot(base),'manual-tasks',id+'.json');};
function add(base,uid,nickname=''){if(!/^\d{5,20}$/.test(uid))throw Error('用户 UID 无效');const box=read(registry(base),{schema:1,users:{}});box.users[uid]={...box.users[uid],uid,nickname:String(nickname||box.users[uid]?.nickname||'用户 '+uid).slice(0,100)};atomic(registry(base),box);return box.users[uid];}
function viewed(base,uid,metadata={}){const box=read(registry(base),{schema:1,users:{}}),old=box.users[uid]||{uid,nickname:'用户 '+uid};box.users[uid]={...old,lastViewedAt:new Date().toISOString(),nickname:metadata.nickname||old.nickname,aliases:[...new Set([...(old.aliases||[]),old.nickname,metadata.nickname].filter(Boolean))],latestInteractionMs:Math.max(old.latestInteractionMs||0,metadata.latestInteractionMs||0)};atomic(registry(base),box);}
function tasks(base,{readTask}={}){const root=path.join(readerRoot(base),'manual-tasks'),view=require('../lib/file-view-cache'),manifest=view.manifest(root,{filter:/^[a-f0-9-]{36}\.json$/});return manifest.files.flatMap(({file})=>{let value;try{value=readTask?readTask(file):view.readJSON(file);}catch{return [];}if(value?.schema!==1||!value.query)return [];if(value.status==='running'){let alive=false;try{process.kill(value.pid,0);alive=true;}catch{}if(!alive)value.status='interrupted';}return [value];}).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));}
function begin(base,job){if(!job.query?.syncOnly||job.preview||job.automatic)return;const q={...job.query},parent=q._resumeTaskId;delete q._resumeTaskId;atomic(taskFile(base,job.id),{schema:1,id:job.id,uid:q.mode==='post-comments'?'':require('./ui/form-utils').uid(q.target),target:q.target,requestId:job.requestId||null,query:q,status:'running',pid:job.child?.pid||process.pid,startedAt:job.startedAt});if(parent){const previous=read(taskFile(base,parent),null);if(previous)atomic(taskFile(base,parent),{...previous,resumedBy:job.id});}}
function finish(base,job,code){if(!job.query?.syncOnly||job.preview||job.automatic)return;const file=taskFile(base,job.id),row=read(file,null)||(!fs.existsSync(file)?{schema:1,id:job.id,uid:job.query.mode==='post-comments'?'':require('./ui/form-utils').uid(job.query.target),target:job.query.target,requestId:job.requestId||null,query:job.query,startedAt:job.startedAt}:null);if(!row||row.id!==job.id)throw Error('任务记录无法核实，正文与收尾证据保留');atomic(file,{...row,status:job.cancelled||job.result?.cancelled?'interrupted':code!==0&&(code!=null||!job.result)||job.exitSignal?'failed':job.result?.incomplete?'partial':'complete',finishedAt:new Date().toISOString(),summary:job.result||null,credits:job.credits||null});}
function resume(base,id,{budget,inspect=false}={}){
 const task=read(taskFile(base,id),null);
 if(!task?.query||task.status==='complete'||task.resumedBy||task.userGapChoice)throw Error('原任务已完成或已有后续任务，请使用对应的待继续任务');
 const q={...task.query,_resumeTaskId:id};
 if(inspect==='query')return q;
 if(!['comments-sent','comments-received','comments-both'].includes(q.mode)||q.source&&q.source!=='cli'||!q._scopeId){
  if(inspect)return {middle:false};
  if(budget!==undefined)throw Error('原待补区间已变化，请重新打开任务');
  return q;
 }
 const S=require('../lib/storage'),paths=S.storagePaths(base),dir=S.mappedFolder(paths.users,task.uid,S.indexRead(paths.users)),I=require('../lib/incremental'),states=['sent','received'].map(k=>I.readState(dir,k,task.uid));
 const options=require('../lib/options').options(require('./acquisition-arguments').buildArguments(q));
 const progress=require('../lib/data-update'),scoped={...options,taskScopeId:q._scopeId,resumeScope:true};
 const directions=progress.taskDirections(dir,scoped);
 const allowed=require('../lib/core').plan(options).filter(p=>p.budget>0).map(p=>p.kind);
 if(!allowed.some(kind=>{
  try{return !!progress.readProgress(dir,kind,scoped)||directions.unstarted(kind)||states.some(s=>s?.kind===kind&&s.pending?.ownerScopes?.includes(q._scopeId)&&s.pending.packets?.length);}
  catch(error){if(allowed.length===1)throw error;return false;}
 }))throw progress.resumeError();
 const journalStatus=require('./task-status'),status=journalStatus.describe(task,journalStatus.journals(dir,task.uid),states,dir);
 const kinds=status.directions.filter(d=>d.pendingNew||q._gapKinds?.includes(d.kind)).map(d=>d.kind);
 const middle=(status.targetCovered||Number.isSafeInteger(q._gapBudget))&&kinds.length>0;
 if(inspect){
  const prices=require('./price-reference').snapshot(base).rows;
  const units=kinds.map(kind=>prices.find(p=>p.id===kind&&p.priceType==='per_record')?.unitPrice);
  return {middle,kinds,unitPrice:units.length&&units.every(Number.isFinite)?Math.max(...units):null,suggested:Math.min(50,Number(q.limit)>0?Number(q.limit):50)};
 }
 delete q._gapBudget;delete q._gapKinds;
 if(middle){
  if(!Number.isSafeInteger(budget)||budget<1)throw Error('请先设置本次补齐最多返回的条数');
  for(const kind of kinds)progress.checkMiddleResume(dir,kind,scoped);
  q._gapBudget=budget;
  q._gapKinds=kinds;
 }else if(budget!==undefined)throw Error('原待补区间已变化，请重新打开任务');
 return q;
}
// This is presentation metadata only. It cannot certify a gap, change a cursor,
// abandon a task or prevent an explicit resume from acquisition history.
function dismissNotice(base,{uid,id,expected}){
 if(!/^\d{5,20}$/.test(uid)||!/^([a-f0-9]{64})$/.test(expected||''))throw Error('提示身份无效');
 const file=taskFile(base,id),revision=require('../lib/update-progress').token(file),task=tasks(base).find(t=>t.id===id&&t.uid===uid&&t.query?.mode!=='post-comments');
 if(!task||task.status==='running'||task.resumedBy||task.userGapChoice)throw Error('原任务已改变，请刷新后重试');
 const S=require('../lib/storage'),p=S.storagePaths(base),dir=S.mappedFolder(p.users,uid,S.indexRead(p.users)),I=require('../lib/incremental'),states=['sent','received'].map(k=>I.readState(dir,k,uid));
 const current=require('./task-status').taskStatus(dir,uid,[task],states).pendingTasks[0];
 if(!current||current.noticeToken!==expected)throw Error('该提示的进度已改变，请刷新后重试');
 if(current.progressStatus.canIgnoreGap)throw Error('中间区间需要使用明确的忽略操作，原任务保留');
 const original=read(file,null);if(require('../lib/update-progress').token(file)!==revision)throw Error('原任务已改变，请刷新后重试');atomic(file,{...original,noticeDismissal:{token:expected,at:new Date().toISOString()}});
 return {uid,id,expected,noticeDismissed:true};
}
// Presentation only: an old immutable task may predate the distinction between
// historical absence and an actionable continuation. Preserve its raw history.
function taskView(task,status){
 if(!task||!['historical-missing','historical-unverified'].includes(status?.kind))return task||null;
 const sources=(task.summary?.sources||[]).map(s=>{
  if(!s.readProgress?.targetCovered&&!s.dataStatus?.targetCovered)return s;
  return {...s,readProgress:{...s.readProgress,pending:false,pendingNew:false},...(s.update?{update:{...s.update,pending:false,caughtUp:true}}:{})};
 });
 return {...task,summary:{...task.summary,historicalMissingIds:status.missingBodyIds||[],sources}};
}
function latestCheckAt(previous,follow,owned=[]){
 let latest=previous||null;
 const observe=at=>{if(Number.isFinite(Date.parse(at))&&(!latest||Date.parse(at)>Date.parse(latest)))latest=at;};
 for(const kind of ['sent','received'])observe(follow?.successfulChecks?.[kind]);
 const continuations=new Set(owned.map(task=>task.resumedBy).filter(Boolean));
 for(const task of owned){
  const {query,summary}=task;
  if(!['complete','partial'].includes(task.status)||task.completedByOtherRun||continuations.has(task.id)||
     !['comments-sent','comments-received','comments-both'].includes(query.mode)||query.source&&query.source!=='cli'||
     query.preview||query.from||query.to||query.before||query._resumeTaskId||query._gapBudget||
     summary?.persistence?.coreSaved!==true)continue;
  if(summary.sources?.some(source=>
   ['sent','received'].includes(source.kind)&&!source.failed&&!source.cancelled&&!source.coverageUnverified&&
   !source.dataStatus?.failed&&!source.dataStatus?.coverageUnverified&&source.requests>(source.cachedCalls??0)&&
   (source.readProgress?.targetCovered===true||source.dataStatus?.targetCovered===true||
    source.dataStatus?.status==='exhausted'||source.update?.caughtUp===true)
  ))observe(task.finishedAt);
 }
 return latest;
}
function home(base,accounts,following,{avatars=true,onlyUids=null}={}){
 const saved=read(registry(base),{schema:1,users:{}}),map=new Map(),followByUid=new Map(),tasksByUid=new Map();
 const included=uid=>!onlyUids||onlyUids.has(uid);
 for(const user of Object.values(saved.users))if(included(user.uid))map.set(user.uid,user);
 for(const account of accounts){
  if(!included(account.uid))continue;
  const previous=map.get(account.uid);
  const aliases=[...new Set([...(previous?.aliases||[]),previous?.nickname,account.nickname].filter(Boolean))];
  map.set(account.uid,{...previous,...account,aliases});
 }
 const {kind}=require('../lib/subscription-key');
 for(const follow of following){
  if(kind(follow)!=='user'||!included(follow.uid)||followByUid.has(follow.uid))continue;
  followByUid.set(follow.uid,follow);
  if(!map.has(follow.uid))map.set(follow.uid,{uid:follow.uid,nickname:'用户 '+follow.uid});
 }
 for(const task of tasks(base)){
  if(task.query.mode==='post-comments'||!map.has(task.uid))continue;
  const owned=tasksByUid.get(task.uid);
  if(owned)owned.push(task);else tasksByUid.set(task.uid,[task]);
 }
 const p=require('../lib/storage').storagePaths(base),index=require('../lib/storage').indexRead(p.users);
 return [...map.values()].map(u=>{const follow=followByUid.get(u.uid),inbox=follow?.inbox||(()=>{try{return require('../lib/follow-inbox').existingSummary(base,u.uid);}catch(error){return {unread:null,unavailable:true,warning:error.message};}})(),dir=require('../lib/storage').mappedFolder(p.users,u.uid,index),states=['sent','received'].map(kind=>read(path.join(dir,'cache/updates',kind+'.json'),null)),checked=states.map((s,i)=>[s?.endPolicyVersion===2&&!s?.baselineUnverified&&!s?.importedEvidence?s.checkedAt:null,read(path.join(dir,'cache/latest-interaction',(i?'received':'sent')+'.json'),null)?.successfulAt].filter(v=>Number.isFinite(Date.parse(v))).sort().at(-1)||null),success=checked.filter(Boolean).sort().at(-1)||null,latest=Math.max(u.latestInteractionMs||0,inbox?.lastSent?.ms||0,inbox?.lastReceived?.ms||0),owned=tasksByUid.get(u.uid)||[],taskState=require('./task-status').taskStatus(dir,u.uid,owned,states),pending=taskState.pendingTasks.map(t=>({...t,historicalContinuation:t.status!=='running'&&t.id!==owned[0]?.id})),notice=require('./task-status').pendingNotice(pending,states,follow);const profile=require('./user-profiles').view(base,u.uid,{avatar:avatars});return {...u,...profile,nickname:profile.nickname||u.nickname,note:typeof u.note==='string'?u.note:'',unread:inbox?.unavailable?null:inbox?.unread||0,unreadUnavailable:!!inbox?.unavailable,lastSuccessAt:success,lastCheckAt:latestCheckAt(success,follow,owned),directions:states.map((s,i)=>({kind:i?'received':'sent',checkedAt:checked[i],pending:!!s?.pending})),pendingEvidence:states.flatMap((s,i)=>s?.pending?[{source:'cli',kind:i?'received':'sent',taskId:s.pending.id||null,scope:s.pending.ownerScopes||[],token:crypto.createHash('sha256').update(JSON.stringify([u.uid,i?'received':'sent',s.pending])).digest('hex')}]:[]),latestInteractionMs:latest||null,followEnabled:!!follow?.enabled,followStatus:follow?.status||'off',pendingTasks:pending,historicalIssues:taskState.historicalIssues,latestTask:taskView(owned[0],taskState.historicalIssues.find(t=>t.id===owned[0]?.id)?.progressStatus),hasPending:notice.pending,pendingMessage:notice.message,pendingDetail:notice.detail};});
}
function task(base,id){const value=read(taskFile(base,id),null);if(value==null)return null;if(value.schema!==1||value.id!==id||!value.query)throw Error('原任务身份无法核实');return value;}
function alreadyConnected(base,id){const file=taskFile(base,id),task=read(file,null);if(!task?.query?._scopeId)return false;const o=require('../lib/options').options(require('./acquisition-arguments').buildArguments(task.query)),p=require('../lib/storage').storagePaths(base),dir=require('../lib/storage').mappedFolder(p.users,o.uid,require('../lib/storage').indexRead(p.users)),kinds=require('../lib/core').plan(o).filter(p=>p.budget>0).map(p=>p.kind);if(kinds.every(k=>require('../lib/update-progress').connectedScope(require('../lib/incremental').stateFile(dir,k),task.query._scopeId))){atomic(file,{...task,status:'complete',finishedAt:new Date().toISOString(),completedByOtherRun:true});return true;}return false;}
module.exports={alreadyConnected,add,viewed,home,tasks,task,begin,finish,resume,dismissNotice,registry,latestCheckAt};
