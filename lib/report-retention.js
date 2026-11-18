'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {reportPayload,formalIds}=require('./report-records'),{loadIndependentArchive}=require('./completeness');
const group=r=>r.category+'|'+(r.uid||r.account)+'|'+r.mode;
function cleanupUnlocked(workspace,{keep=1,protect=[],listReports,containedReport,perOwner=true,scopeOwners=null}={}){
 const bucket=perOwner?r=>r.category==='post-comments'?(r.postId?'post:'+r.postId:''):(r.uid?'user:'+r.uid:''):group;
 if(keep==null)return {removed:0,skipped:0};if(!Number.isSafeInteger(keep)||keep<1)throw Error('保留报告数量必须为正整数，或关闭清理');
 const reports=listReports(workspace),pins=require('./report-lifecycle').pins(workspace),protectedIds=new Set(pins.map(p=>p.id)),focus=new Set(scopeOwners||reports.filter(r=>protect.includes(r.id)).map(bucket).filter(Boolean)),groups=new Map(),archives=new Map(),regenerable=new Map();let removed=0,skipped=0,deferred=false;
 if(perOwner&&protect.length&&!focus.size)return {removed:0,skipped:0};
 for(const report of reports){const key=bucket(report);if(!key||(!perOwner&&report.merged)||!report.mode||focus.size&&!focus.has(key))continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(report);}
 for(const versions of groups.values()){
  const retain=new Set(versions.slice(0,keep).map(r=>r.id));for(const r of versions)if(protectedIds.has(r.id))retain.add(r.id);
  if(perOwner&&retain.size>keep)deferred=true;
  for(const report of versions){if(retain.has(report.id))continue;try{
   const file=containedReport(workspace,report.id),bytes=require('./regular-file').read(file);
   // A complete formal payload cannot recover edits to the report around it.
   if(report.localHash!==undefined&&crypto.createHash('sha256').update(bytes).digest('hex')!==report.localHash){skipped++;continue;}
   const html=bytes.toString('utf8'),dir=require('./data-layout').dataForReport(workspace,path.dirname(file));let rows=[];
   if(report.category==='user-comments'){
    const payload=reportPayload(html,report.uid);rows=payload?.rows||[];
    if(!payload){let archive=archives.get(dir);if(!archive){archive=new Map();for(const kind of ['sent','received','mentions-comments','mentions-posts'])for(const [id,entry]of loadIndependentArchive(dir,kind,report.uid).records)archive.set((kind==='mentions-posts'?'post:':'comment:')+id,entry.row);archives.set(dir,archive);}const prefix=report.mode==='mentions-posts'?'post:':'comment:';const ids=formalIds(html,report.uid);if(!ids.length){skipped++;continue;}rows=ids.map(id=>archive.get(prefix+id));if(rows.some(r=>!r)){skipped++;continue;}}
    // An embedded payload is the recovery copy after HTML removal. A filtered,
    // partial or body-less payload must never certify that the report is safe
    // to discard, even when its JSON and IDs are syntactically valid.
    if(!rows.length||rows.length!==report.count||new Set(rows.map(require('./records').recordKey)).size!==rows.length||rows.some(r=>!require('./record-body').completeBody(r))){skipped++;continue;}
    if(rows.length){const bytes=JSON.stringify({schema:1,uid:report.uid,rows}),hash=crypto.createHash('sha256').update(bytes).digest('hex'),snapshot=path.join(dir,'cache/report-snapshots',hash+'.json');require('./workspace-access').directory(workspace,path.relative(workspace,path.dirname(snapshot)),{create:true});
     if(!fs.existsSync(snapshot))require('./durable-write').atomicBytes(snapshot,Buffer.from(bytes));
     else{const sync=require('./fs-sync'),saved=require('./regular-file').read(snapshot);if(saved.toString('utf8')!==bytes){skipped++;continue;}sync.path(snapshot);sync.directory(path.dirname(snapshot));}
     const verified=require('./regular-file').read(snapshot);if(crypto.createHash('sha256').update(verified).digest('hex')!==hash||verified.toString('utf8')!==bytes){skipped++;continue;}}
   }
   // Delete these exports only when every exported root ID is still regenerable.
   if(report.category==='post-comments'||report.category==='posts'){
    const identity=JSON.stringify([dir,report.category,report.postId||report.uid]);let known=regenerable.get(identity);if(!known){const local=require('./local-database'),available=report.category==='post-comments'?local.localPostComments({postId:report.postId},dir):local.localPosts({uid:report.uid},dir);known=new Set(available.rows.map(row=>row.recordId||row.id));regenerable.set(identity,known);}
    const ids=report.category==='post-comments'?formalIds(html,report.uid):[...html.matchAll(/<article[^>]*data-post\b[\s\S]*?<footer>[\s\S]*?data-copy-id="(\d+)"/g)].map(m=>m[1]);
    if(!ids.length||ids.length!==report.count||ids.some(id=>!known.has(id))){skipped++;continue;}
   }
   // Associated local image files and raw JSON are never deleted.
   fs.unlinkSync(file);removed++;
  }catch{skipped++;}}
 }
 return {removed,skipped,...(deferred?{deferred:true}:{})};
}
function cleanupReports(workspace,options={}){try{return require('./report-lifecycle').locked(workspace,()=>{const result=cleanupUnlocked(workspace,options);if(result.deferred&&options.queueMaintenance!==false)require('./report-catalog').defer(workspace,options.protect||[]);return result;});}catch(error){if(error.code!=='DATA_LOCK_BUSY')throw error;if(options.queueMaintenance!==false)require('./report-catalog').defer(workspace,options.protect||[]);return {removed:0,skipped:0,deferred:true};}}
module.exports={cleanupReports};
