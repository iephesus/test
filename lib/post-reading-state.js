"use strict";
// Reading is independent of body storage and source-specific continuity. A durable
// start precedes requests; first-save receipts recover unread IDs after crashes.
const fs=require('node:fs'),path=require('node:path'),V=require('./file-view-cache'),S=require('./storage'),inbox=require('./follow-inbox');
function folder(base,id){if(typeof id!=='string'||!/^\d{5,20}$/.test(id))throw Error('微博 ID 无效');return S.findPostFolder(S.storagePaths(base).postComments,id);}
const file=(base,id)=>path.join(folder(base,id),'cache/post-reading-state.json');
const registry=base=>path.join(require('./data-layout').readerRoot(base),'post-reading-targets.json');
function read(name,empty){try{return V.readJSON(name);}catch(e){if(e.code==='ENOENT')return empty;throw e;}}
function validate(b,id){if(b&&(b.schema!==2||b.postId!==id||!b.items||typeof b.items!=='object'||Array.isArray(b.items)||!b.receipts||typeof b.receipts!=='object'||Array.isArray(b.receipts)||b.receiptHashes!=null&&(!b.receiptHashes||typeof b.receiptHashes!=='object'||Array.isArray(b.receiptHashes)||Object.values(b.receiptHashes).some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))))throw Error('博文阅读状态损坏，原文件保留');return b;}
function load(base,id){return validate(read(file(base,id),null),id);}
function unreadSummary(base,id){
 try{
  return V.fileView(file(base,id),'post-unread:'+id,b=>({unread:inbox.unreadIds(validate(b,id)).size}));
 }catch(error){return error.code==='ENOENT'?{unread:null}:{unread:null,unavailable:true};}
}
function manifests(base,id){const dir=folder(base,id),root=path.join(dir,'cache'),out=[];
 for(const e of V.manifest(path.join(root,'request-journal'),{strict:true,filter:/^[a-f0-9-]+\.response\.json$/}).files)out.push({...e,relative:path.relative(root,e.file),kind:'cli'});
 const crawler=path.join(root,'crawler-v1');if(fs.existsSync(crawler))for(const item of fs.readdirSync(crawler,{withFileTypes:true})){if(item.isSymbolicLink())throw Error('历史网页的阅读证据目录不可靠');if(!item.isDirectory()||!/^[a-f0-9]{64}$/.test(item.name))continue;for(const e of V.manifest(path.join(crawler,item.name),{strict:true,filter:/^[a-f0-9-]{36}\.json$/}).files)out.push({...e,relative:path.relative(root,e.file),kind:'crawler',key:item.name});}
 return out;
}
function remember(base,id){const name=registry(base),lease=require('./process-lease').acquire(name+'.lock','博文未读恢复清单正在保存，请稍后重试');try{const b=read(name,{schema:1,ids:[]});if(b.schema!==1||!Array.isArray(b.ids)||b.ids.some(v=>typeof v!=='string'||!/^\d{5,20}$/.test(v)))throw Error('博文未读恢复清单损坏');if(!b.ids.includes(id)){b.ids.push(id);require('./auto-follow-budget').atomic(name,b);}}finally{lease.release();}}
function locked(base,id,fn){const lease=require('./process-lease').acquire(file(base,id)+'.lock','博文阅读状态正在保存');try{return fn();}finally{lease.release();}}
function fingerprint(e){return V.fileView(e.file,'post-reading-receipt-hash',(_,meta)=>({signature:meta.signature,hash:meta.hash()}));}
function baseline(base,id){const receipts={},receiptHashes={};for(const e of manifests(base,id)){const p=fingerprint(e);receipts[e.relative]=p.signature;receiptHashes[e.relative]=p.hash;}return {receipts,receiptHashes};}
function plan(base,id){return load(base,id)||{schema:2,postId:id,startedAt:new Date().toISOString(),items:{},...baseline(base,id)};}
function start(base,id,{batchId}={}){return locked(base,id,()=>{let b=load(base,id);remember(base,id);if(!b){b={schema:2,postId:id,startedAt:new Date().toISOString(),items:{},...baseline(base,id)};if(batchId){const batch=require('./database-sync').readBatch(folder(base,id),batchId);if(batch.category!=='post-comments'||batch.target!==id)throw Error('指定未读批次与博文不匹配');const keys=new Set(batch.newKeys);for(const r of batch.rows)if(keys.has('comment:'+r.recordId)&&r.postId===id&&require('./record-body').completeBody(r))b.items[r.recordId]={id:r.recordId,firstSeenAt:batch.createdAt,readAt:null};b.startBatch=batchId;}require('./auto-follow-budget').atomic(file(base,id),b);}return b;});}
function crawlerEvidence(e,id,dir){
 const raw=V.readJSON(e.file),request=raw.request,kind=(/^(?:comments(?:-verify)?:[a-f0-9-]{36}|candidate:\d{5,20})$/.test(request?.purpose||''))?'post':request?.purpose==='post-follow:'+id?'post-follow':request?.purpose==='post-check:'+id?'post-check':null;
 if(!kind||path.basename(e.file)!==request.id+'.json'||require('./post-links').parsePostTarget(request.url)!==id||require('./legacy-web-evidence').scopeKey(request.scope,kind,id)!==e.key)throw Error('历史网页的首次保存证据身份不匹配');
 const store=require('./legacy-web-evidence').open(dir,{scope:request.scope,kind,id}),b=store.receipt({id:request.id}).value;
 if(b.parsed.postId!==id||request.status!==200)throw Error('历史网页的首次保存证据无效');return {store,b,request};
}
function observation(e,id,dir){
 if(e.kind==='cli'){const b=V.readJSON(e.file);if(b.schema!==1||b.query?.uid!==id||b.query.kind!=='post-comments'||!Array.isArray(b.firstSavedIds))throw Error('博文首次保存收据无法核实');return {ids:b.firstSavedIds,rows:require('./post-comments').postPageRows(b.response,id).rows,at:b.savedAt};}
 const {b,request}=crawlerEvidence(e,id,dir);return {ids:b.parsed.firstIndependentIds||[],rows:b.parsed.rows||[],at:request.receivedAt};
}
function legacyCtimeHash(e,id,dir,before,after){
 // Legacy states kept a filesystem token, not a content hash. A changed ctime
 // alone is accepted only with an independent, exact-scope progress receipt.
 const old=String(before).split('/'),current=after.split('/');if(e.kind!=='crawler'||old.length!==5||old.slice(0,4).some((v,i)=>v!==current[i]))return '';
 const {store,request}=crawlerEvidence(e,id,dir),progress=store.load();
 const refs=[progress?.homeReceipt,progress?.lastReceipt,...(Array.isArray(progress?.receipts)?progress.receipts:[])].filter(r=>r?.id===request.id);
 const hashes=new Set(refs.map(r=>r.hash));return hashes.size===1&&/^[a-f0-9]{64}$/.test([...hashes][0])?[...hashes][0]:'';
}
function reconcile(base,id){const b=load(base,id);if(!b)return {value:null,dirty:false};let dirty=false;const dir=folder(base,id);b.receiptHashes??={};
 for(const e of manifests(base,id)){
  const previous=b.receipts[e.relative],knownHash=b.receiptHashes[e.relative];if(previous===e.signature&&knownHash)continue;
  const p=fingerprint(e);
  if(previous){const expected=knownHash||(previous===p.signature?p.hash:legacyCtimeHash(e,id,dir,previous,p.signature));if(!expected||expected!==p.hash)throw Object.assign(Error('博文首次保存证据发生变化，未覆盖阅读状态'),{code:'POST_READING_EVIDENCE_CHANGED'});}
  else{const o=observation(e,id,dir);if(!Number.isFinite(Date.parse(o.at))||!Array.isArray(o.ids))throw Error('首次保存时间或身份无效');const keys=new Set(o.ids);for(const r of o.rows)if(keys.has(r.recordId)&&r.postId===id&&!r.isContext&&require('./completeness').exactId(r.recordId)&&require('./record-body').completeBody(r)&&!b.items[r.recordId])b.items[r.recordId]={id:r.recordId,firstSeenAt:o.at,readAt:null};}
  if(V.stamp(e.file)?.signature!==p.signature)throw Object.assign(Error('首次保存收据在核对期间变化，请重试'),{code:'LOCAL_VIEW_CHANGED'});
  b.receipts[e.relative]=p.signature;b.receiptHashes[e.relative]=p.hash;dirty=true;
 }
 return {value:b,dirty};
}
function recover(base,id,{dryRun=false}={}){
 if(dryRun)return reconcile(base,id).value;
 return locked(base,id,()=>{const {value,dirty}=reconcile(base,id);if(dirty)require('./auto-follow-budget').atomic(file(base,id),value);return value;});
}
function hasState(base,id){return !!V.regularStamp(file(base,id));}
function version(base,id){
 const state=V.regularStamp(file(base,id));
 return state?JSON.stringify([state.signature,manifests(base,id).map(entry=>[entry.relative,entry.signature])]):'absent';
}
function recoverWorkspace(base){const b=read(registry(base),{schema:1,ids:[]});if(b.schema!==1||!Array.isArray(b.ids))throw Error('博文未读恢复清单损坏');for(const id of b.ids)if(fs.existsSync(file(base,id)))recover(base,id);}
function view(base,id){return load(base,id)||{schema:2,postId:id,items:{},tracking:false};}
function markRead(base,id,ids){return locked(base,id,()=>{const {value:b,dirty}=reconcile(base,id);if(!b)return {changed:0,unread:0};let changed=0;for(const id of new Set(ids)){const r=b.items[id];if(r?.id===id&&!r.readAt){r.readAt=new Date().toISOString();changed++;}}if(changed||dirty)require('./auto-follow-budget').atomic(file(base,b.postId),b);return {changed,unread:inbox.unreadIds(b).size};});}
module.exports={file,plan,start,recover,recoverWorkspace,view,hasState,version,markRead,unreadSummary};
