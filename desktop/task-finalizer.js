'use strict';
// Child responses/checkpoints remain the data authority. Recovery only repairs
// local bookkeeping; it never starts a content request or advances a data cursor.
const fs=require('node:fs'),path=require('node:path');
const {atomic}=require('../lib/update-progress'),{readerRoot}=require('../lib/data-layout');
function createFinalizer(base,hooks){
 const folder=path.join(readerRoot(base),'task-finalization'),inProgress=new Set(),issues=new Map();
 function issue(id,journal,failures){
  const ux=require('./ui/form-utils'),post=journal?.query?.mode==='post-comments',target=post?ux.postId(journal?.query?.target):ux.uid(journal?.query?.target);
  issues.set(id,{id,file:id==='directory'?'task-finalization':id+'.json',targetKind:target?(post?'post':'user'):null,target:target||null,blocking:failures.some(f=>f.critical),failures:failures.map(({stage,message,critical})=>({stage,message:String(message).slice(0,600),critical:!!critical}))});
 }
 const recoveryBlocked=()=>[...issues.values()].some(e=>e.blocking);
 const recoveryState=()=>({blocked:recoveryBlocked(),issues:[...issues.values()]});
 const blockedFor=query=>{const ux=require('./ui/form-utils'),post=query?.mode==='post-comments',target=post?ux.postId(query?.target):ux.uid(query?.target);return [...issues.values()].filter(e=>e.blocking&&(!e.target||!target||e.targetKind===(post?'post':'user')&&e.target===target));};
 const feeStages=new Set(['recovery-evidence','billing-history','subscription-settlement','finalization-record','automatic-hold']);
 const save=journal=>atomic(path.join(folder,journal.id+'.json'),journal);
 function finalize(job,options={}){
  if(job.finalized||inProgress.has(job.id))return null;
  inProgress.add(job.id);try{return performFinalize(job,options);}finally{inProgress.delete(job.id);}
 }
 function performFinalize(job,{code=null,signal=null,recovery=false}={}){
  if(job.finalized)return null;
  job.finalized=true;
  const missingSummary=job.kind==='collect'&&job.query?.syncOnly&&!job.preview&&!job.result?.syncOnly;
  const effectiveCode=code||((signal||missingSummary)?1:code);
  const journal=job.finalization||{schema:1,id:job.id,status:'pending',kind:job.kind,automatic:!!job.automatic,query:job.query||null,requestId:job.requestId,preview:!!job.preview,cancelled:!!job.cancelled,startedAt:job.startedAt,result:job.result||null,credits:job.credits||null,safety:job.safety||null,reports:job.reports||[],code,signal,steps:[],failures:[]};
  const post=job.query?.mode==='post-comments',target=job.query?.target;const ux=require('./ui/form-utils');Object.assign(journal,{targetKind:post?'post':'user',uid:post?'':ux.uid(target),...(post?{postId:ux.postId(target)}:{})});
  journal.steps=Array.isArray(journal.steps)?journal.steps.filter(s=>typeof s==='string'):[];
  const failures=(Array.isArray(journal.failures)?journal.failures:[]).filter(f=>f&&typeof f.stage==='string').map(f=>({...f}));
  let durable=false,held=false;
  const clear=stage=>{for(let i=failures.length-1;i>=0;i--)if((failures[i].ownerStage||failures[i].stage)===stage)failures.splice(i,1);};
  function warn(stage,error,critical=false,ownerStage=stage){const value={stage,message:String(error?.message||error).slice(0,600),critical,ownerStage};if(!failures.some(f=>f.stage===value.stage&&f.message===value.message&&f.ownerStage===value.ownerStage))failures.push(value);}
  function checkpoint(stage){journal.failures=failures;if(!durable)return;try{save(journal);}catch(error){warn('checkpoint:'+stage,error,true,stage);}}
  function attempt(stage,action,critical=false){
   // Persisted warnings from a completed stage remain until explicitly repaired.
   if(journal.steps.includes(stage))return;
   clear(stage);
   try{
    const value=action();
    for(const warning of value?.warnings||[])warn(warning.stage||stage,warning.message||warning,!!warning.critical,stage);
    if(value?.coreFailed||value?.ignored&&!value?.alreadySettled)throw Error(value?.message||(value?.warnings||[]).map(w=>w.message).filter(Boolean).join('；')||'必要结算未完成，恢复证据保留');
    journal.steps.push(stage);checkpoint(stage);
   }catch(error){warn(stage,error,critical,stage);}
  }
  for(const warning of job.result?.partialFailures||[])warn(warning.stage||'derived-data',warning.message||warning,false,'child-result');
  try{
   try{save(journal);durable=true;for(let i=failures.length-1;i>=0;i--)if(['recovery-evidence','finalization-record'].includes(failures[i].stage)||failures[i].stage.startsWith('checkpoint:'))failures.splice(i,1);}catch(error){warn('recovery-evidence',error,true);}
   attempt('task-record',()=>hooks.taskRecord?.(job,effectiveCode,{signal,recovery,missingSummary}),false);
   attempt('billing-history',()=>hooks.billingHistory?.(job,effectiveCode,{signal,recovery,missingSummary}),true);
   if(job.automatic)attempt('subscription-settlement',()=>{if(!hooks.settle)throw Error('自动订阅结算处理器不可用');return hooks.settle(job,effectiveCode,{signal,recovery,missingSummary});},true);
  }finally{
   // A failed observer, file write or UI notification cannot retain ownership.
   clear('resources');
   try{hooks.release?.(job);}catch(error){warn('resources',error,true);}
  }
  if(recovery&&failures.some(f=>['child-result','derived-repair'].includes(f.ownerStage)))journal.steps=journal.steps.filter(s=>s!=='derived-repair');
  if(hooks.repairDerived)attempt('derived-repair',()=>{const result=hooks.repairDerived?.(job,{recovery});for(const stage of result?.repairedStages||[])for(let i=failures.length-1;i>=0;i--)if(failures[i].ownerStage==='child-result'&&failures[i].stage===stage)failures.splice(i,1);return result;},false);
  if(!job.automatic)attempt('unread-and-subscription',()=>hooks.observe?.(job),false);
  attempt('report-cleanup',()=>hooks.cleanup?.(job),false);
  attempt('home-refresh',()=>hooks.refresh?.(),false);
  function holdAutomatic(){
   if(held||!job.automatic||!failures.some(f=>f.critical&&(feeStages.has(f.stage)||feeStages.has(f.ownerStage))))return;
   held=true;
   try{if(!hooks.criticalFailure)throw Error('自动订阅尚未确认暂停，必要结算仍待修复');const result=hooks.criticalFailure(job,failures,{recovery});if(result?.coreFailed||result?.held!==true)throw Error(result?.message||'自动订阅暂停状态未能保存，后续请求必须停止');clear('automatic-hold');for(const w of result?.warnings||[])warn(w.stage||'automatic-hold',w.message||w,!!w.critical,'automatic-hold');}
   catch(error){warn('automatic-hold',error,true);}
  }
  function persistFinal(critical=true){
   journal.failures=failures;journal.status=failures.some(f=>f.critical||f.stage==='task-record')?'pending':'settled';journal.finishedAt=new Date().toISOString();
   try{save(journal);durable=true;}catch(error){warn(critical?'finalization-record':'notification-record',error,critical);if(critical)journal.status='pending';}
  }
  holdAutomatic();persistFinal();holdAutomatic();
  const result={id:job.id,taskId:job.id,requestId:job.requestId,kind:job.kind,automatic:!!job.automatic,code:effectiveCode,exitCode:code,signal,cancelled:!!job.cancelled,preview:!!job.preview,partial:!!job.result?.incomplete||missingSummary,coreFailed:failures.some(f=>f.critical),dataSaved:!!job.result?.syncOnly,cancelSaved:!!job.result?.syncOnly,reports:job.automatic?[]:job.reports||[],partialFailures:failures,recovery,...(job.result?.inventoryRepair?{inventoryRepair:job.result.inventoryRepair}:{})};
  try{hooks.finished?.(result);}catch(error){warn('finished-notification',error,false);persistFinal(false);result.coreFailed=failures.some(f=>f.critical);}
  if(journal.status==='pending'||result.coreFailed)issue(job.id,journal,failures);else issues.delete(job.id);
  return result;
 }
 function recover(){
  // Do not forget an unsaved in-memory failure just because there is no file.
  for(const id of [...issues.keys()])if(id==='directory'||fs.existsSync(path.join(folder,id+'.json')))issues.delete(id);
  if(!fs.existsSync(folder))return [];
  const results=[];
  let names;
  try{names=require('./finalization-index').pending(folder);}catch(error){issue('directory',null,[{stage:'recovery-scan',message:error.message,critical:true}]);return results;}
  function invalid(name,journal,message){const id=name.slice(0,-5);issue(id,journal,[{stage:'recovery-journal',message,critical:true}]);try{hooks.recoveryWarning?.({id,file:name,message});}catch{}}
  for(const name of names){
   if(inProgress.has(name.slice(0,-5)))continue;
   let journal;
   try{journal=JSON.parse(require('../lib/regular-file').read(path.join(folder,name),{maxBytes:16*1024*1024}));}catch(error){invalid(name,null,String(error.message));continue;}
   if(journal?.schema!==1||!['pending','settled'].includes(journal.status)||journal.id+'.json'!==name){invalid(name,null,'任务恢复记录格式或身份不匹配，请保留原文件并修复');continue;}
   if(journal.status==='settled')continue;
   try{const result=finalize({...journal,finalization:journal,timers:[]},{code:journal.code,signal:journal.signal,recovery:true});if(result)results.push(result);}
   catch(error){invalid(name,journal,String(error.message));}
  }
  return results;
 }
 return {finalize,recover,recoveryBlocked,recoveryState,blockedFor};
}
module.exports={createFinalizer};
