'use strict';
// Rebuild only derived task metadata from a durably returned summary/batch.
// This module never reads a service client or changes success cursors.
const fs=require('node:fs'),path=require('node:path');
function repairDerived(base,job,{scheduleInventory}={}){
 const summary=job.result,stages=new Set((summary?.partialFailures||[]).map(e=>e.stage)),repairedStages=[],warnings=[];
 if(!summary?.syncOnly||!['database-index','update-history','inventory-index','post-reading-state'].some(s=>stages.has(s)))return {repairedStages,warnings};
 const {o,target,dir}=require('./task-data').taskData(base,job.query);
 if(summary.target!==target)throw Error('更新摘要与任务身份不一致，未修复派生索引');
 if(summary.persistence?.coreSaved===true&&stages.has('inventory-index')&&scheduleInventory)summary.inventoryRepair=scheduleInventory(job);
 const category=require('../lib/database-sync').category(o),ledger=require('../lib/database-sync');
 const attempt=(stage,fn)=>{if(!stages.has(stage))return;try{fn();repairedStages.push(stage);}catch(error){warnings.push({stage,message:error.message});}};
 attempt('post-reading-state',()=>{if(category==='post-comments')require('../lib/post-reading-state').recover(base,target);});
 attempt('database-index',()=>{
  const entries=ledger.statuses(base),old=entries.find(e=>e.target===target&&e.category===category&&e.mode===o.mode);
  // Old task recovery must not roll back a newer statistics index either.
  if(old&&Date.parse(old.updatedAt)>Date.parse(summary.updatedAt))return;
  const entry={...old,target,uid:o.uid||'',mode:o.mode,category,label:summary.label,updatedAt:summary.updatedAt,lastSuccessAt:summary.incomplete?old?.lastSuccessAt||null:summary.updatedAt,incomplete:summary.incomplete,addedRecords:summary.addedRecords,records:summary.records,from:o.from||'',to:o.to||'',batchId:summary.batchId||old?.batchId||null};
  require('../lib/update-progress').atomic(path.join(require('../lib/data-layout').readerRoot(base),'database-status.json'),{schema:1,entries:[entry,...entries.filter(e=>!(e.target===target&&e.category===category&&e.mode===o.mode))]});
 });
 attempt('update-history',()=>{
  const id=summary.batchId||job.id;if(!/^[a-zA-Z0-9_-]+$/.test(id||''))throw Error('历史记录编号无法核实');
  if(fs.existsSync(path.join(dir,'cache/update-history',id+'.json')))return;
  ledger.writeHistory(dir,{schema:1,id,target,uid:o.uid||'',mode:o.mode,category,label:summary.label,startedAt:job.startedAt,finishedAt:summary.updatedAt,status:summary.cancelled?'interrupted':summary.incomplete?'partial':'complete',autoRoundId:summary.autoRoundId||null,operation:job.automatic?'automatic':job.query.syncOperation==='quick'?'quick':o.from||o.to?'range':'regular',from:o.from||'',to:o.to||'',batchId:summary.batchId,records:summary.records,addedRecords:summary.addedRecords,newReturned:summary.newRecords,reusedRecords:summary.reusedRecords,apiCalls:summary.apiCalls,cachedCalls:summary.cachedCalls,sources:summary.sources||[],billing:ledger.billingRecord(summary.billing,summary.apiCalls),reason:'根据已保存更新摘要恢复派生历史，未重新请求内容'});
 });
 return {repairedStages,warnings};
}
function recordIncompleteHistory(base,job){
 if(job.kind!=='collect'||!job.query?.syncOnly||job.preview||job.result?.syncOnly)return;
 const {o,target,dir}=require('./task-data').taskData(base,job.query);
 const ledger=require('../lib/database-sync');
 const apiCalls=job.credits?.requests??null;
 const billing=ledger.billingRecord(
  {...job.credits,unknownRequests:Math.max(1,job.credits?.unknownRequests||0)},apiCalls??1);
 ledger.writeHistory(dir,{
  schema:1,id:job.id,target,uid:o.uid,mode:o.mode,
  startedAt:job.startedAt,finishedAt:new Date().toISOString(),
  status:job.cancelled?'interrupted':'failed',apiCalls,billing,
  reason:'未取得完整收尾结果；已保存原始数据与恢复证据保留，费用待核对'
 });
}
module.exports={repairDerived,recordIncompleteHistory};
