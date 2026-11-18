'use strict';
// Persistent, rebuildable statistics only. No body text, network client, read flags
// or checkpoint authority. Each source owns reference counts so overlapping
// responses, replaced files and restored bodies adjust totals without recounting.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const views=require('./file-view-cache'),sources=require('./inventory-sources');
// v6 rebuilds identity-derived contributions after lossless normalization changes,
// even when the original response bytes have not changed.
const SCHEMA=1,VERSION=6,MAX_ENTRIES=8,MAX_BYTES=20*1024*1024,cache=new Map();let used=0;
const TIMELINE_READ_BYTES=64*1024*1024;
const metrics={sourceReads:0,sourceBytes:0,rebuilds:0,updates:0,indexReads:0,hits:0};
const file=dir=>path.join(dir,'cache/local-inventory-v1.json');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modes=owner=>owner.category==='user-comments'?{sent:['sent'],received:['received'],both:['sent','received'],'mentions-comments':['mentions-comments'],'mentions-posts':['mentions-posts'],all:['sent','received','mentions-comments','mentions-posts']}:Object.fromEntries(sources.kinds(owner).map(k=>[k,[k]]));
function manifest(dir,owner,{strict=false}={}){const root=path.join(dir,'cache'),m=views.manifest(root,{strict,children:['request-journal','report-snapshots','exchange-v1','data-updates']});const files=m.files.map(f=>({...f,relative:path.relative(root,f.file).split(path.sep).join('/')})).filter(f=>sources.sourceKind(f.relative,owner));const poolSignature=require('./exchange-store').signatureFor(dir);return {files,poolSignature,token:hash([poolSignature,files.map(f=>[f.relative,f.signature])])};}
function retain(name,stamp,value,bytes){const previous=cache.get(name);if(previous){used-=previous.bytes;cache.delete(name);}if(bytes>MAX_BYTES)return;while(cache.size>=MAX_ENTRIES||used+bytes>MAX_BYTES){const first=cache.keys().next().value;used-=cache.get(first).bytes;cache.delete(first);}cache.set(name,{stamp,value,bytes});used+=bytes;}
function readIndex(name,owner,{bounded=false}={}){
 const check=bounded?views.regularStamp:views.stamp;
 try{
  const stamp=check(name)?.signature;if(!stamp)return null;const old=cache.get(name);if(old?.stamp===stamp){metrics.hits++;cache.delete(name);cache.set(name,old);return old.value;}
  const bytes=bounded?require('./regular-file').read(name,{maxBytes:TIMELINE_READ_BYTES}):fs.readFileSync(name);metrics.indexReads++;const box=JSON.parse(bytes);
  if(box.schema!==SCHEMA||box.version!==VERSION||box.owner?.id!==owner.id||box.owner?.category!==owner.category||!box.data?.files||!box.data?.refs||!box.data?.totals||box.hash!==hash(box.data)||bounded&&check(name)?.signature!==stamp)return null;
  retain(name,stamp,box.data,bytes.length);return box.data;
 }catch(error){if(error.code&&error.code!=='ENOENT'&&!(bounded&&error.code==='LOCAL_SOURCE_INVALID'))throw error;return null;}
}
function empty(owner){return {files:{},refs:Object.fromEntries(sources.kinds(owner).map(k=>[k,{}])),totals:Object.fromEntries(Object.keys(modes(owner)).map(k=>[k,{records:0,missingBodyCount:0}])),manifest:'',updatedAt:null};}
function presence(state,kinds,id){let known=false,body=false;for(const k of kinds){const refs=state.refs[k]?.[id];known||=refs?.[0]>0;body||=refs?.[1]>0;}return {records:body?1:0,missingBodyCount:known&&!body?1:0};}
function replace(state,owner,old={},next={}){
 const affected=new Map(),config=modes(owner);
 for(const part of [old,next])for(const [kind,ids]of Object.entries(part))for(const id of new Set([...ids.known,...ids.bodies])){
  for(const [mode,kinds]of Object.entries(config))if(kinds.includes(kind)){
   // Comment IDs and status IDs are distinct in the combined legacy summary.
   const type=kind==='mentions-posts'||kind==='user-posts'?'post:':'comment:',key=mode+'|'+type+id;
   if(!affected.has(key)){const matching=kinds.filter(k=>(k==='mentions-posts'||k==='user-posts'?'post:':'comment:')===type);affected.set(key,{mode,id,kinds:matching,before:presence(state,matching,id)});}
  }
 }
 for(const [part,sign]of [[old,-1],[next,1]])for(const [kind,ids]of Object.entries(part)){
  for(const [at,values]of [[0,ids.known],[1,ids.bodies]])for(const id of values){const ref=state.refs[kind][id]??=[0,0];ref[at]+=sign;if(ref[at]<0)throw Error('本地统计引用计数无效');}
  for(const id of new Set([...ids.known,...ids.bodies]))if(state.refs[kind][id]?.every(n=>n===0))delete state.refs[kind][id];
 }
 for(const {mode,id,kinds,before}of affected.values()){const after=presence(state,kinds,id);for(const name of ['records','missingBodyCount'])state.totals[mode][name]+=after[name]-before[name];}
}
function changed(entry,phase,expected,observed){return Object.assign(Error('统计来源在读取时变化'),{code:'LOCAL_VIEW_CHANGED',diagnostic:{source:entry.relative,phase,code:'LOCAL_VIEW_CHANGED',expected:expected?hash(expected).slice(0,20):'absent',observed:observed?hash(observed).slice(0,20):'absent'}});}
function sourceValue(entry,owner,maxBytes){const before=views.stamp(entry.file);if(!before||before.signature!==entry.signature)throw changed(entry,'before-read',entry.signature,before?.signature);let bytes;try{bytes=require('./regular-file').read(entry.file,{maxBytes});}catch(error){error.diagnostic={source:entry.relative,phase:'read',code:error.code||'LOCAL_READ_FAILED'};throw error;}metrics.sourceReads++;metrics.sourceBytes+=bytes.length;let contribution={},warning='',diagnostic;
 try{contribution=sources.project(entry.relative,JSON.parse(bytes),owner,bytes,entry.file);}catch(error){warning=entry.relative+'：'+(error instanceof SyntaxError?'来源格式损坏':error.message);diagnostic={source:entry.relative,phase:'project',code:error instanceof SyntaxError?'INVALID_JSON':error.code||'LOCAL_PROJECTION_FAILED'};}
 const after=views.stamp(entry.file);if(after?.signature!==before.signature)throw changed(entry,'after-read',before.signature,after?.signature);return {signature:entry.signature,contribution,...(warning?{warning,diagnostic}:{})};}
function output(state,kind,persistenceWarning=''){const warnings=Object.values(state.files).map(f=>f.warning).filter(Boolean);if(persistenceWarning)warnings.push(persistenceWarning);return {...state.totals[kind],complete:!warnings.length,warnings:warnings.slice(0,20),localOnly:true,credits:0,...(Object.values(state.files).some(f=>f.diagnostic)?{diagnostics:Object.values(state.files).map(f=>f.diagnostic).filter(Boolean)}:{})};}
function validate(owner){if(!owner||!['user-comments','post-comments','posts'].includes(owner.category)||typeof owner.id!=='string'||!/^\d{5,20}$/.test(owner.id))throw Error('本地统计身份无效');return {id:owner.id,category:owner.category};}
function* projectChanges(dir,owner,previous,m,{strict=false,maxBytes}={}){
 const state=previous?structuredClone(previous):empty(owner),wanted=new Set(m.files.map(f=>f.relative));
 for(const [relative,old]of Object.entries(state.files))if(!wanted.has(relative)){replace(state,owner,old.contribution,{});delete state.files[relative];}
 for(const entry of m.files){const old=state.files[entry.relative];if(old?.signature===entry.signature)continue;yield;const next=sourceValue(entry,owner,maxBytes);replace(state,owner,old?.contribution,next.contribution);state.files[entry.relative]=next;}
 // Never publish an index or a projection for a half-observed response set.
 const after=manifest(dir,owner,{strict});if(after.token!==m.token){const now=new Map(after.files.map(e=>[e.relative,e.signature])),entry=m.files.find(e=>e.signature!==now.get(e.relative))||after.files.find(e=>!wanted.has(e.relative));throw changed(entry||{relative:'<shared-content>'},'before-commit',m.token,after.token);}
 return state;
}
function* compute(dir,owner,kind){
 owner=validate(owner);if(!modes(owner)[kind])throw Error('本地统计内容方向无效');
 const name=file(dir);let previous=readIndex(name,owner),m=manifest(dir,owner);
 if(previous&&previous.poolSignature!==m.poolSignature)previous=null;
 if(previous?.manifest===m.token)return output(previous,kind);
 let lease;try{lease=require('./process-lease').acquire(name+'.lock','本地统计正在更新');}catch(error){if(previous&&error.code==='DATA_LOCK_BUSY')return {...output(previous,kind),updating:true};throw error;}
 try{
  previous=readIndex(name,owner);m=manifest(dir,owner);if(previous&&previous.poolSignature!==m.poolSignature)previous=null;
 if(previous?.manifest===m.token)return output(previous,kind);
  const state=yield* projectChanges(dir,owner,previous,m);
  state.manifest=m.token;state.poolSignature=m.poolSignature;state.updatedAt=new Date().toISOString();const box={schema:SCHEMA,version:VERSION,owner,data:state,hash:hash(state)},bytes=JSON.stringify(box);
  try{require('./update-progress').atomic(name,box);retain(name,views.stamp(name).signature,state,Buffer.byteLength(bytes));}
  catch(error){return {...output(state,kind,'统计结果未能保存：'+error.message),diagnostic:{source:'local-inventory-v1.json',phase:'save-index',code:error.code||'LOCAL_INDEX_WRITE_FAILED'}};}
  if(previous)metrics.updates++;else metrics.rebuilds++;return output(state,kind);
 }finally{lease.release();}
}
function inventory(dir,owner,kind){const iterator=compute(dir,owner,kind);let next;do{next=iterator.next();}while(!next.done);return next.value;}
async function inventoryAsync(dir,owner,kind,{signal}={}){const iterator=compute(dir,owner,kind),checkpoint=require('./local-work').checkpoint(signal,8);try{for(;;){signal?.throwIfAborted();const next=iterator.next();if(next.done)return next.value;await checkpoint();}}finally{iterator.return();}}
// A timeline needs candidate IDs and locators, never direction or continuity
// authority from the derived statistics. A stale index is projected in memory.
async function timelineMissingCandidates(dir,owner,{signal}={}){
 owner=validate(owner);if(owner.category!=='user-comments')throw Error('时间轴需要用户互动对象');
 const kinds=['sent','received'],options={strict:true,maxBytes:TIMELINE_READ_BYTES},tick=require('./local-work').checkpoint(signal,6);
 const cacheDir=path.join(dir,'cache');if(fs.existsSync(cacheDir)&&fs.lstatSync(cacheDir).isSymbolicLink())throw Error('时间轴缓存目录不能为符号链接');
 const m=manifest(dir,owner,options);let state=readIndex(file(dir),owner,{bounded:true});
 if(state?.poolSignature!==m.poolSignature)state=null;
 if(state?.manifest!==m.token){const next=projectChanges(dir,owner,state,m,options);for(;;){await tick();const step=next.next();if(step.done){state=step.value;break;}}}
 const ids=new Set();
 for(const kind of kinds)for(const id in state.refs[kind]){await tick();if(presence(state,kinds,id).missingBodyCount)ids.add(id);}
 const hits=new Map();
 if(ids.size)for(const entry of m.files){
  await tick();const contribution=state.files[entry.relative]?.contribution;if(!contribution)continue;
  const matching=new Set();for(const kind of kinds)for(const id of contribution[kind]?.known||[])if(ids.has(id))matching.add(id);
  if(matching.size)hits.set(entry.relative,{...entry,ids:matching});
 }
 if(manifest(dir,owner,options).token!==m.token)throw changed({relative:'<timeline-sources>'},'after-projection',m.token);
 return {ids,hits,token:m.token,warnings:output(state,'both').warnings};
}
function snapshot(dir,owner){owner=validate(owner);const state=readIndex(file(dir),owner);if(!state||state.manifest!==manifest(dir,owner).token)return null;return {version:state.manifest,updatedAt:state.updatedAt,totals:Object.fromEntries(Object.keys(modes(owner)).map(k=>[k,output(state,k)])),diagnostics:Object.values(state.files).map(f=>f.diagnostic).filter(Boolean)};}
function update(dir,owner){owner=validate(owner);return inventory(dir,owner,Object.keys(modes(owner))[0]);}
function completeIds(dir,owner,ids){const result=inventory(dir,owner,owner.category==='post-comments'?'post-comments':'both');if(!result.complete)throw Error('正文清单无法核实，保留响应后停止');const state=readIndex(file(dir),validate(owner));if(!state||state.manifest!==manifest(dir,owner).token)throw Error('正文清单正在变化');return new Set(ids.filter(id=>presence(state,sources.kinds(owner),id).records));}
function clear(){cache.clear();used=0;for(const k of Object.keys(metrics))metrics[k]=0;}
function stats(){return {...metrics,entries:cache.size,estimatedBytes:used,maxBytes:MAX_BYTES,maxEntries:MAX_ENTRIES};}
module.exports={inventory,inventoryAsync,timelineMissingCandidates,snapshot,update,file,clear,stats,manifest,completeIds};
