'use strict';
const fs=require('node:fs'),path=require('node:path');
const {rawArray,apiError,normalize,sortRecords,targetNickname}=require('./core');
const {restorePacket}=require('./incremental');
const {exactId}=require('./completeness');
const {render}=require('./reader');
const {sourceIncomplete}=require('./limits');

// Recover one exact collection run from its saved, fingerprinted responses.
// No network, checkpoint mutation or selection of unrelated archive records.
function recoverUpdateRun(runFile){
 const audit=path.resolve(runFile),dir=path.dirname(path.dirname(path.dirname(audit)));
 if(path.basename(path.dirname(audit))!=='runs'||path.basename(path.dirname(path.dirname(audit)))!=='cache')throw Error('请选择 cache/runs 中的采集记录');
 const run=JSON.parse(fs.readFileSync(audit,'utf8'));
 if(run.schema!==1||!/^\d{5,20}$/.test(run.uid)||!Number.isFinite(Date.parse(run.createdAt))||!Array.isArray(run.endpoints)||!run.endpoints.length)throw Error('采集记录格式无效');
 const kinds=run.endpoints.map(s=>s.kind);
 if(kinds.some(k=>!['sent','received'].includes(k))||new Set(kinds).size!==kinds.length||run.endpoints.some(s=>!s.update))throw Error('仅支持评论增量采集记录');
 const sources=[],all=new Map();let label='',returned=0;
 for(const source of run.endpoints){
  if(!Array.isArray(source.packets))throw Error('采集记录缺少原始响应索引');
  const rows=new Map();
  for(const ref of source.packets){
   if(ref.kind!==source.kind)throw Error('响应接口不匹配');
   const packet=restorePacket({file:ref.file,hash:ref.responseHash,stamp:Date.parse(ref.savedAt)},dir),parsed=rawArray(packet.raw,source.kind);
   if(!parsed||apiError(packet.raw))throw Error('原始响应不可用');
   if(!ref.cached)returned+=parsed.items.length;
   if(!label)label=targetNickname(packet.raw,source.kind,run.uid);
   for(const raw of parsed.items){
    const row=normalize(raw,source.kind,run.uid);
    if(!exactId(row.recordId)||!Number.isFinite(row.ms)||!row.content?.trim()||(source.kind==='sent'&&row.authorUid!==run.uid))throw Error('响应中存在无法安全恢复的正式评论');
    row.provenance={type:'cache',file:path.relative(dir,packet.file),savedAt:ref.savedAt,responseHash:ref.responseHash};
    row.group='both';row.type=source.kind==='sent'?'发出':'收到';rows.set(row.recordId,row);
    if(all.has(row.recordId))all.get(row.recordId).type='发出/收到';else all.set(row.recordId,row);
   }
  }
  const values=sortRecords([...rows.values()]);
  sources.push({kind:source.kind,budget:values.length,rows:values,fetched:values.length,requests:0,cachedCalls:source.packets.length,ended:!!source.ended,update:source.update,reason:source.reason});
 }
 if(!all.size)throw Error('本次响应没有可恢复的评论，未生成空报告');
 label=label||path.basename(dir);const mode=kinds.length===2?'both':kinds[0],rows=sortRecords([...all.values()]);
 const names=require('./report-name'),base=require('./exchange-store').baseFor(audit,true),options={uid:run.uid,mode,offline:true,recoveryInfo:true,reportPartial:sources.some(sourceIncomplete),...(base?{workspace:base}:{})},first=path.join(require('./data-layout').reportDir(dir),names.fileName(label,options,rows.length));
 const file=base?require('./report-catalog').write(first,options,rows,label,()=>render(options,rows,sources,label),require('./report-catalog').contentKey(options,rows,sources,label)).file:names.writeExclusive(first,render(options,rows,sources,label));
 return {file,uid:run.uid,count:rows.length,returned,newCredits:0,sources:sources.map(s=>({kind:s.kind,count:s.rows.length})),gap:sources.flatMap(s=>s.update.gap?.unresolvedIds||[])};
}
module.exports={recoverUpdateRun};
