'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {storagePaths}=require('./storage'),{sortRecords}=require('./core'),{exactId}=require('./completeness');
const key=row=>(row.group==='mentions-posts'||row.id&&!row.recordId?'post:':'comment:')+(row.recordId||row.id||'');
function trackNewRecords(o,beforeKeys){
 if(!o.syncOnly||o.autoGuard||!require('./events').enabled())return;
 const added=new Set();
 o.noteNewRecords=rows=>{
  const previous=added.size;
  for(const row of rows){
   if(row.isContext||!exactId(row.recordId||row.id))continue;
   const id=key(row);
   if(!beforeKeys?.has(id))added.add(id);
  }
  if(added.size!==previous)require('./events').emit('progress',{addedRecords:added.size});
 };
}
const category=o=>o.mode==='post-comments'?'post-comments':o.mode==='user-posts'?'posts':'user-comments';
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
function statuses(base){try{const value=JSON.parse(fs.readFileSync(path.join(require('./data-layout').readerRoot(base),'database-status.json')));return value.schema===1&&Array.isArray(value.entries)?value.entries:[];}catch{return [];}}
function readBatch(dir,id){
 if(!/^[0-9TZ-]+_[a-f0-9-]{36}$/.test(id||''))throw Error('更新批次无效，请重新选择本次更新');
 const folder=path.join(dir,'cache/batches'),file=path.join(folder,id+'.json');
 if(!fs.existsSync(file)||!fs.realpathSync(file).startsWith(fs.realpathSync(folder)+path.sep))throw Error('更新批次不存在或路径越界，原始数据保留');
 const value=require('./file-view-cache').readJSON(file);if(value.schema!==1||value.id!==id||!Array.isArray(value.rows)||!Array.isArray(value.newKeys))throw Error('更新批次格式无效');
 const allowed=new Set(['sent','received','mentions-comments','mentions-posts','post-comments','user-posts']);
 if(!allowed.has(value.mode)&&!['both','all'].includes(value.mode))throw Error('更新批次功能无效');
 value.rows=value.rows.filter(row=>!row.isContext&&exactId(row.recordId||row.id)&&Number.isFinite(row.ms)&&typeof(row.content??row.text)==='string');return value;
}
function finishSync(o,dir,results,label,beforeKeys=null){
 const now=new Date().toISOString(),id=now.replace(/[:.]/g,'-')+'_'+crypto.randomUUID(),records=new Map(),added=new Map();
 function retain(row){if(row.isContext)return;const member=row.group+'|'+key(row),old=records.get(member);records.set(member,old?require('./exchange-merge').merge(row,old,row.group):row);}
 for(const r of results){for(const row of (o.autoFollow?r.newRows:r.rows)||[])retain(row);for(const row of r.newRows||(beforeKeys?(r.rows||[]).filter(row=>!beforeKeys.has(key(row))):[]))if(!row.isContext){retain(row);added.set(key(row),row);}}
 const recordCount=new Set([...records.values()].map(key)).size;
 const rows=sortRecords([...records.values()]),batch={schema:1,id,uid:o.uid||'',target:o.postId||o.uid,mode:o.mode,category:category(o),label,createdAt:now,from:o.from||'',to:o.to||'',rows,newKeys:[...added.keys()],sources:results.map(r=>({kind:r.kind||o.mode,stopCode:r.stopCode||r.autoStop?.code||null,returnLimited:!!r.returnLimited,located:typeof r.located==='boolean'?r.located:null,repliesIncomplete:!!r.incompleteReplies?.length,dataStatus:require('./collection-result').collectionResult(r),budget:Number.isFinite(r.budget)?r.budget:null,fetched:r.fetched??r.rows?.length??0,requests:r.requests||0,cachedCalls:r.cachedCalls||0,ended:!!r.ended,failed:!!r.failed,coverageUnverified:!!r.coverageUnverified,reason:r.reason||'',cancelled:!!r.cancelled,readProgress:r.readProgress||null,reusedCount:r.reusedCount??r.update?.reusedCount??0,coveredCount:r.coveredCount??r.rows?.length??0,latestActivityMs:(r.activityRows||r.newRows||[]).reduce((n,x)=>Math.max(n,x.ms||0),0),...require('./subscription-activity').directionActivity(r,o.postId||o.uid,new Set(added.keys())),savedIndependentCount:require('./subscription-activity').directionActivity({...r,activityRows:null},o.postId||o.uid,new Set(added.keys())).newIndependentCount,update:r.update||null}))};
 const incomplete=results.some(r=>r.stopCode==='DIRECTION_NOT_CHECKED'||(r.kind==='post-comments'||o.mode==='user-posts'?r.complete===false:require('./limits').sourceIncomplete(r)));
 batch.incomplete=incomplete;batch.failed=results.some(r=>r.failed);
 const billing=o.creditMeter?.snapshot()||o.syncBilling||null;
 batch.billing=billing;if(!o.autoFollow||added.size)atomic(path.join(dir,'cache/batches',id+'.json'),batch);
 const partialFailures=[],aux=(stage,fn)=>{try{fn();}catch(error){partialFailures.push({stage,message:error.message,...(error.code?{code:error.code}:{}),...(error.diagnostic?{diagnostic:error.diagnostic}:{})});}};
 const summary={persistence:{coreSaved:true},partialFailures,syncOnly:true,target:batch.target,uid:batch.uid,mode:o.mode,category:batch.category,label,billing,written:0,records:recordCount,addedRecords:added.size,newRecords:results.reduce((n,r)=>n+(r.newFetched||0),0),apiCalls:results.reduce((n,r)=>n+(r.apiCalls??((r.requests||0)-(r.cachedCalls||0))),0),cachedCalls:results.reduce((n,r)=>n+(r.cachedCalls||0),0),incomplete,cancelled:!!o.cancelled||require('./cancellation').cancelled()||results.some(r=>r.cancelled),reusedRecords:results.reduce((n,r)=>n+(r.reusedCount??r.update?.reusedCount??0),0),batchId:o.autoFollow&&!added.size?null:id,autoRoundId:o.autoRoundId||null,autoStop:results.map(r=>r.autoStop).find(Boolean)||null,sources:batch.sources,updatedAt:now,from:o.from||'',to:o.to||''};
 if(batch.category==='post-comments')aux('post-reading-state',()=>require('./post-reading-state').recover(require('./exchange-store').baseFor(dir),batch.target));
 aux('inventory-index',()=>{
  const index=require('./inventory-index'),owner={id:batch.target,category:batch.category};
  let result;
  try{result=index.update(dir,owner);}catch(error){
   if(error.code!=='LOCAL_VIEW_CHANGED')throw error;
   result=index.update(dir,owner);
  }
  if(result.complete===false)throw Object.assign(Error(result.warnings.join('；')||'本地统计尚未更新'),{code:result.diagnostic?.code||'LOCAL_SOURCE_INVALID',diagnostic:result.diagnostic});
 });
 const inventoryFailure=partialFailures.find(f=>f.stage==='inventory-index');if(inventoryFailure)aux('inventory-repair-queue',()=>{const base=require('./exchange-store').baseFor(dir),work=require('./inventory-repair-state').queue(base,{id:batch.target,category:batch.category},summary.batchId||id,inventoryFailure.diagnostic);summary.inventoryRepair={id:work.id,state:'queued'};});
 aux('database-index',()=>{
 const entries=statuses(),previous=entries.find(e=>e.target===batch.target&&e.category===batch.category&&e.mode===o.mode),entry={...previous,target:batch.target,uid:batch.uid,mode:o.mode,category:batch.category,label,updatedAt:now,lastSuccessAt:incomplete?previous?.lastSuccessAt||null:now,incomplete,addedRecords:added.size,records:recordCount,from:batch.from,to:batch.to,batchId:o.autoFollow&&!added.size?previous?.batchId||null:id};
 atomic(path.join(require('./data-layout').readerRoot(),'database-status.json'),{schema:1,entries:[entry,...entries.filter(e=>!(e.target===entry.target&&e.category===entry.category&&e.mode===entry.mode))]});
 });
 console.log(`数据${summary.cancelled?'已中断，已有内容与进度保留':incomplete?'已保存，范围尚未完成':'更新完成'}：本次新保存 ${added.size} 条独立记录；未生成 HTML，报告可另行本地生成。`);
 aux('update-history',()=>writeHistory(dir,{schema:1,id,persistence:summary.persistence,target:batch.target,uid:batch.uid,mode:o.mode,category:batch.category,label,startedAt:o.syncStartedAt||now,finishedAt:now,status:summary.cancelled?'interrupted':batch.failed?'failed':incomplete?'partial':'complete',autoRoundId:o.autoRoundId||null,operation:o.autoFollow?'automatic':o.update?'quick':batch.from||batch.to?'range':'regular',requestedLimit:Number.isFinite(o.count)?o.count:null,returnBudget:Number.isFinite(o.gapBudget?.limit??o.returnBudget??o.count)?o.gapBudget?.limit??o.returnBudget??o.count:null,reusedRecords:summary.reusedRecords,requestLimit:Number.isFinite(o.pages)?o.pages:null,pageSize:o.pageSize,before:Number.isFinite(o.beforeMs)?require('./core').beforeDisplay(o):'',sources:batch.sources,from:batch.from,to:batch.to,batchId:summary.batchId,records:recordCount,addedRecords:added.size,apiCalls:summary.apiCalls,cachedCalls:summary.cachedCalls,newReturned:summary.newRecords,billing:billingRecord(billing,summary.apiCalls),reason:results.map(r=>r.reason).filter(Boolean).join('；')}));
 require('./events').emit('summary',summary);return summary;
}
function billingRecord(value,calls){const initial=value?.initialBalance??null,final=value?.finalBalance??null,unknown=value?.unknownRequests||0;return {estimatedCredits:value?.estimatedCredits??(calls===0?0:null),actualCredits:calls===0&&!unknown?0:null,balanceBefore:initial,balanceAfter:final,balanceDecrease:initial!=null&&final!=null?Number((initial-final).toFixed(6)):null,unknownRequests:unknown,status:unknown?'unverified':calls===0?'no-content-requests':initial!=null&&final!=null?'balance-observed':'estimated-only'};}
function writeHistory(dir,value){atomic(path.join(dir,'cache/update-history',value.id+'.json'),value);}
function historyEntry(dir,id){
 if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,200}$/.test(id))throw Error('获取历史编号无效');
 const folder=path.join(dir,'cache/update-history'),file=path.join(folder,id+'.json');
 if(!fs.existsSync(file))return null;
 if(!fs.realpathSync(file).startsWith(fs.realpathSync(folder)+path.sep))throw Error('获取历史路径越界');
 const value=require('./file-view-cache').readJSON(file);
 if(value?.schema!==1||value.id!==id||!Number.isFinite(Date.parse(value.finishedAt)))throw Error('获取历史身份或时间无法核实');
 return value;
}
function history(dir){const folder=path.join(dir,'cache/update-history');const root=fs.existsSync(folder)?fs.realpathSync(folder):null,rows=[];for(const file of (root?fs.readdirSync(folder):[]).filter(n=>/^[a-zA-Z0-9_-]+\.json$/.test(n)))try{const p=path.join(folder,file);if(!fs.realpathSync(p).startsWith(root+path.sep))continue;const value=JSON.parse(fs.readFileSync(p));if(value.schema===1&&value.id&&value.finishedAt)rows.push(value);}catch{}const runs=path.join(dir,'cache/runs');if(fs.existsSync(runs))for(const name of fs.readdirSync(runs).filter(n=>n.endsWith('.json')))try{const run=JSON.parse(fs.readFileSync(path.join(runs,name)));if(run.schema!==1||run.syncOnly||!Number.isFinite(Date.parse(run.createdAt)))continue;const endpoints=run.endpoints||[],packets=endpoints.flatMap(e=>e.packets||[]);rows.push({schema:1,id:name.replace(/\.json$/,''),uid:run.uid,mode:run.mode,finishedAt:run.createdAt,startedAt:null,status:'legacy',records:endpoints.reduce((n,e)=>n+(e.records?.length||0),0),addedRecords:null,apiCalls:packets.filter(p=>!p.cached).length,cachedCalls:packets.filter(p=>p.cached).length,billing:{status:'legacy-unverified',actualCredits:null,estimatedCredits:null,unknownRequests:1},reason:'旧版采集审计，仅能还原已记录的范围和请求；当时未保存余额变化，实际费用无法事后确认。'});}catch{}return rows.sort((a,b)=>b.finishedAt.localeCompare(a.finishedAt));}
module.exports={history,historyEntry,writeHistory,billingRecord,key,category,statuses,readBatch,finishSync,trackNewRecords};
