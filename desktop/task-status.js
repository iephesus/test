'use strict';
const fs=require('node:fs'),path=require('node:path');
const unfinished=new Set(['partial','interrupted','failed']);
function journalSnapshot(dir,uid){
 const root=path.join(dir,'cache/data-updates'),values=[],warnings=[];
 if(!fs.existsSync(root))return {values,warnings};
 if(!fs.lstatSync(root).isDirectory())throw Error('获取证据目录无法核实');
 const regular=require('../lib/regular-file');
 for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(!entry.name.endsWith('.json'))continue;
  try{
   const value=JSON.parse(regular.read(path.join(root,entry.name),{maxBytes:16*1024*1024}));
   if(value?.schema===1&&value.uid===uid&&Array.isArray(value.ownerScopes))values.push({...value,journalFile:entry.name});
   else warnings.push({kind:value?.kind,message:'旧任务证据格式或身份无法解释'});
  }catch{warnings.push({message:'获取证据损坏：'+entry.name});}
 }
 return {values,warnings};
}
function journals(dir,uid){return journalSnapshot(dir,uid).values;}
function savedBodies(dir,kind,uid){
 const views=require('../lib/file-view-cache'),root=path.join(dir,'cache'),manifest=views.manifest(root,{filter:/^(?!follow-inbox).*\.json$/,children:['request-journal','report-snapshots','exchange-v1']});
 // Bounded, rebuildable body-presence cache only. Never pagination evidence.
 return new Set(views.memo('task-body-presence\0'+root+'\0'+kind+'\0'+uid,manifest.signature,()=>[...require('../lib/completeness').loadIndependentArchive(dir,kind,uid).records.keys()]));
}
function recentCliTask(task){
 const q=task.query;
 return !!q?._scopeId&&(!q.source||q.source==='cli')&&!q.from&&!q.to&&!q.before;
}
function savedProgress(dir,journal){
 if(journal.status!=='pending'||typeof journal.cursor!=='string')return false;
 if(journal.packets?.length||journal.selectedIds?.length)return true;
 const request=journal.request;
 if(!dir||!request)return false;
 try{return !!require('../lib/request-journal').recover(dir,{uid:journal.uid,kind:journal.kind,taskId:journal.id,
  count:request.count,maxId:request.max,sinceId:request.since,page:1});}catch{return false;}
}
function describe(task,progress=[],states=[],dir=null,{bodyIdsByKind}={}){
 if(task.userGapChoice||task.resumedBy||!['running',...unfinished].includes(task.status))return {kind:'history',resumable:false,missingBodyIds:[]};
 if(task.status==='running')return {kind:'running',resumable:true,missingBodyIds:[]};
 const scope=task.query?._scopeId,owned=scope?progress.filter(j=>j.ownerScopes.includes(scope)):[],sources=task.summary?.sources||[],missing=new Set();
 let continuation=false,unverified=false;const directions=[],targetCovered=sources.length>0&&sources.every(source=>require('../lib/collection-result').collectionResult(source).targetCovered);
 for(const source of sources){
  const p=source.readProgress||{},allMatching=owned.filter(j=>j.kind===source.kind),recent=!task.query?.from&&!task.query?.to&&!task.query?.before,exact=recent&&scope?path.basename(require('../lib/data-update').progressFile(dir||'.',source.kind,{beforeMs:null,taskScopeId:scope})):null,primary=exact&&allMatching.find(j=>j.journalFile===exact),matching=primary?[primary]:allMatching,state=states.find(s=>s?.kind===source.kind);
  if(state?.userSkippedScopes?.includes(scope))continue;
  const active=!!state?.pending&&(state.pending.ownerScopes?.includes(scope)||matching.some(j=>j.id===state.pending.id));
  const reported=matching.flatMap(j=>j.gapIds||[]),bodies=dir&&reported.length?(bodyIdsByKind?.[source.kind]||savedBodies(dir,source.kind,task.uid)):null,gaps=[...new Set(reported.filter(id=>!bodies?.has(id)))];for(const id of gaps)missing.add(id);
  const outcome=require('../lib/collection-result').collectionResult({...source,missingBodyIds:gaps}),covered=outcome.targetCovered,connected=outcome.pendingNew&&dir&&scope&&state&&!active&&require('../lib/update-progress').connectedScope(require('../lib/incremental').stateFile(dir,source.kind),scope),needsNew=outcome.pendingNew&&!connected;
  const saved=matching.some(j=>savedProgress(dir,j));
  // A covered request can still have unavailable bodies. Those belong to the
  // immutable acquisition history, not to the active pagination queue. Never
  // infer that a later successful task repaired the older missing records.
  if(active||needsNew&&saved||!covered&&saved){continuation=true;directions.push({kind:source.kind,covered:p.covered??source.fetched??0,budget:source.budget??null,reason:source.reason||'',pendingNew:active||needsNew,targetCovered:covered});continue;}
  if(covered&&reported.length&&!needsNew){if(!gaps.length)unverified=true;continue;}
  if(saved&&(p.pending||source.coverageUnverified)){continuation=true;directions.push({kind:source.kind,covered:p.covered??source.fetched??0,budget:source.budget??null,reason:source.reason||'',pendingNew:needsNew,targetCovered:covered});continue;}
  if(source.coverageUnverified||source.failed||source.cancelled)unverified=true;
 }
 // Older interrupted tasks might not have emitted a summary before exit.
 // Only a saved, matching journal provides a continuation in that case.
 if(!sources.length&&owned.some(j=>savedProgress(dir,j)))continuation=true;
 const pendingDirections=directions.filter(d=>d.pendingNew);
 const canIgnoreGap=targetCovered&&recentCliTask(task)&&pendingDirections.length>0&&pendingDirections.every(({kind})=>
  !owned.some(j=>j.kind===kind&&j.currentComparison)&&states.some(s=>s?.kind===kind&&s.pending?.ownerScopes?.includes(scope)));
 return {canIgnoreGap,kind:continuation?'continuation':missing.size?'historical-missing':unverified?'historical-unverified':'history',resumable:continuation,targetCovered,directions,missingBodyIds:[...missing],dataState:continuation?'continuation':missing.size?'historical-missing':task.status==='interrupted'?'interrupted':task.status==='failed'?'failed':unverified?'unverified':'covered'};
}
function taskStatus(dir,uid,tasks,states=[],options={}){
 const pending=tasks.filter(t=>!t.resumedBy&&['running',...unfinished].includes(t.status)),progress=pending.some(t=>t.status!=='running')?(options.progress??journals(dir,uid)):[];
 const described=pending.map(task=>{const dismissToken=require('./gap-choice').token(task,states),progressStatus=describe(task,progress,states,dir,options),noticeToken=require('node:crypto').createHash('sha256').update(JSON.stringify([task.id,task.uid,task.status,task.query,task.finishedAt,task.summary,progressStatus])).digest('hex');return {...task,dismissToken,noticeToken,noticeDismissed:task.status!=='running'&&task.noticeDismissal?.token===noticeToken,progressStatus};});
 return {pendingTasks:described.filter(t=>t.progressStatus.resumable),historicalIssues:described.filter(t=>['historical-missing','historical-unverified'].includes(t.progressStatus.kind))};
}
function pendingNotice(tasks=[],states=[],follow=null){
 if(tasks.some(t=>t.progressStatus?.kind==='running'))return {pending:true,message:'正在获取数据',detail:''};
 const coveredGap=tasks.some(t=>!t.historicalContinuation&&t.progressStatus?.targetCovered&&t.progressStatus?.directions?.some(d=>d.pendingNew));
 if(coveredGap)return {pending:true,message:'新旧数据之间有未读取区间',detail:'本次条数目标已完成；需要时可在详情页补齐中间数据，续读位置仍保留。'};
 if(states.some(s=>s?.pending&&!s.pending.ownerScopes?.some(scope=>tasks.some(t=>t.historicalContinuation&&t.query?._scopeId===scope)))||follow?.directions?.some(s=>!states.some(current=>current?.kind===s.kind)&&require('../lib/collection-result').collectionResult(s).pendingNew))return {pending:true,message:'仍有新增待读取',detail:'新增区间尚未接回原检查位置，续取进度已保存。'};
 tasks=tasks.filter(t=>!t.historicalContinuation);
 if(!tasks.length)return {pending:false,message:'',detail:''};
 const task=tasks[0],dirs=task.progressStatus?.directions||[],labels={sent:'发出',received:'收到','mentions-comments':'评论中的 @','mentions-posts':'微博中的 @'};
 const count=dirs.map(d=>(labels[d.kind]||d.kind)+' '+d.covered+(Number.isFinite(d.budget)?' / '+d.budget:'')+' 条').join('，');
 return {pending:true,message:'上次获取未完成'+(count?'：'+count:''),detail:dirs.map(d=>d.reason).filter(Boolean).join('；')||'保留的是以前未完成的获取范围，不表示当前正在运行。'};
}
module.exports={describe,taskStatus,pendingNotice,journals,journalSnapshot};
