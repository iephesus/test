'use strict';
// Rebuildable per-object content shards; no acquisition client or progress writes.
const fs=require('node:fs'),path=require('node:path'),C=require('./local-corpus'),views=require('./file-view-cache'),{searchableName}=require('./search-text');
const indexFile=(base,o,distribution=false)=>path.join(require('./data-layout').readerRoot(base),'indexes',distribution?'coverage-v1':'search-v1',(distribution?'distribution-':'')+C.hash(o.key)+'.json');
const PROJECTION_VERSION=4;
const metrics={sourceReads:0,indexReads:0,reusedSources:0,updatedSources:0};
async function ensure(base,o,options={}){
 const {signal,progress=()=>{},distribution=false}=options;
 if(!distribution)return require('./search-source-index').scan(base,o,{...options,metrics});
 const tick=require('./local-work').checkpoint(signal,6),m=C.manifest(o),name=indexFile(base,o,distribution);let previous={},valid=false;
 // Reuse only a hash-validated derived shard with the same file identity.
 // Raw manifests are still checked for every query and again before returning.
 try{if(views.regularStamp(name)?.size>16*1024*1024)throw Error('索引过大');previous=views.fileView(name,'search-shard:'+PROJECTION_VERSION+':'+o.key+':'+distribution,(box,{size})=>{metrics.indexReads++;if(size>16*1024*1024)throw Error('索引过大');if(!(box.schema===1&&box.version===PROJECTION_VERSION&&(distribution?box.projection==='distribution':!box.projection||box.projection==='search')&&box.owner===o.key&&box.hash===C.hash(box.files)&&box.files&&typeof box.files==='object'&&!Array.isArray(box.files)&&Object.values(box.files).every(e=>e&&Array.isArray(e.rows)&&e.rows.every(r=>r&&(distribution?typeof r.recordId==='string'&&r.formal===true&&typeof r.usable==='boolean'&&(r.ms===null||Number.isFinite(r.ms)):typeof r.content==='string'&&typeof r.version==='string')))))throw Error('索引无效');return box.files;});valid=true;}catch{}
 const next={};let changed=!valid,done=0;
 for(const e of m.files){await tick();signal?.throwIfAborted();const old=previous[e.relative];if(old?.signature===e.signature){next[e.relative]=old;metrics.reusedSources++;}else{
  changed=true;metrics.sourceReads++;metrics.updatedSources++;
  let rows=[],warning='';try{rows=C.project(e,o,{distribution});}catch(error){warning=path.basename(e.file)+'：'+error.message;}
  if(views.stamp(e.file)?.signature!==(e.sourceSignature||e.signature))throw Error('本地数据正在变化，请重新搜索');next[e.relative]={signature:e.signature,rows,warning};
 }done++;if(done%16===0)progress({object:o.key,done,total:m.files.length});}
 if(C.manifest(o).token!==m.token)throw Error('本地数据正在变化，请重新搜索');
 if(Object.keys(previous).length!==Object.keys(next).length)changed=true;
 const warnings=Object.values(next).map(e=>e.warning).filter(Boolean);
 if(changed||!fs.existsSync(name)){await tick();signal?.throwIfAborted();try{require('./update-progress').atomic(name,{schema:1,version:PROJECTION_VERSION,projection:distribution?'distribution':'search',owner:o.key,files:next,hash:C.hash(next)});}catch(e){warnings.push('索引未能保存：'+e.message);}}
 return {owner:o,token:m.token,files:next,warnings};
}
function conditions(q={}){
 if(typeof q.text!=='string'||q.text.trim().length>4096)throw Error('关键词最多 4096 个字符');
 const text=q.text.trim().normalize('NFC').toLocaleLowerCase();
 const range=require('./date-range').bounds(q.from||'',q.to||'');
 if(q.owner&&!/^(?:user-comments|posts|post-comments):\d{5,20}$/.test(q.owner))throw Error('所属对象身份无效');
 if(q.author!=null&&(typeof q.author!=='string'||q.author.length>200))throw Error('作者条件最多 200 个字符');
 return {text,author:String(q.author||'').trim().normalize('NFC').toLocaleLowerCase(),owner:q.owner||'',start:range.startMs,end:range.endMs};
}
function matches(r,o,q){return (!q.owner||q.owner===o.key)&&(!q.author||(/^\d{5,20}$/.test(q.author)?r.authorUid===q.author:[searchableName(r.author,r.authorUid)].some(v=>String(v||'').normalize('NFC').toLocaleLowerCase().includes(q.author))))&&(q.start===-Infinity&&q.end===Infinity||r.ms!=null&&r.ms>=q.start&&r.ms<=q.end)&&[r.content,searchableName(r.author,r.authorUid),r.postText,searchableName(o.label,o.category==='post-comments'?'':o.id),o.note].join('\n').normalize('NFC').toLocaleLowerCase().includes(q.text);}
async function search(base,input,opts={}){
 const q=conditions(input);if(!q.text)return {state:'idle',rows:[],total:0,unidentified:0,credits:0};
 const tick=require('./local-work').checkpoint(opts.signal,6),catalog=C.objects(base),objects=catalog.objects.filter(o=>!q.owner||o.key===q.owner),groups=new Map(),warnings=[...catalog.warnings],tokens=[],candidates=new Set();let retained=0;
 const retain=bytes=>{retained+=bytes;if(retained>24*1024*1024)throw Object.assign(Error('匹配的内容或保存关联过多，请增加关键词、限定所属对象或日期后重新搜索；已保存数据未改变。'),{code:'LOCAL_SEARCH_LIMIT'});};
 const identity=(o,file,i,r)=>r.recordId?(o.category==='posts'?'post:':'comment:')+r.recordId:'unidentified:'+o.key+':'+file+':'+i;
 // First pass keeps exact matching identities only, never the workspace text.
 for(const o of objects){
  await tick();opts.progress?.({object:o.key,label:o.note||o.label});const shard=await ensure(base,o,{...opts,onSource:async(file,rows,offset)=>{
   for(let i=0;i<rows.length;i++){if(i%128===0)await tick();const r=rows[i];if(!matches(r,o,q))continue;const k=identity(o,file,offset+i,r);if(!candidates.has(k)){retain(Buffer.byteLength(k)+80);candidates.add(k);}}
  }});tokens.push([o.key,shard.token]);warnings.push(...shard.warnings);
 }
 // Stream again for versions/origins of the selected identities. Revalidated
 // source parts use the bounded shared cache; no owner-sized shard survives.
 if(candidates.size)for(const o of objects){
  const shard=await ensure(base,o,{...opts,onSource:async(file,rows,offset)=>{
   for(let i=0;i<rows.length;i++){
    if(i%128===0)await tick();const r=rows[i],type=o.category==='posts'?'post':'comment',k=identity(o,file,offset+i,r);if(!candidates.has(k))continue;
    let g=groups.get(k);if(!g){g={key:k,type,id:r.recordId,versions:new Map()};groups.set(k,g);}
    let v=g.versions.get(r.version);if(!v){retain(640+Object.values(r).reduce((n,value)=>n+(typeof value==='string'?Buffer.byteLength(value):8),0));v={...r,sources:[],hit:false};g.versions.set(r.version,v);}
    const sourceKey=o.key+'|'+r.channel+'|'+r.formal;if(!v.sources.some(s=>s.key===sourceKey)){retain(320+Buffer.byteLength(sourceKey+file+(o.note||o.label)));v.sources.push({key:sourceKey,owner:o.key,label:o.note||o.label,trackedUid:o.category==='user-comments'?o.id:'',channel:r.channel,formal:r.formal,file,anchorId:r.anchorId});}
    v.usable||=r.usable;v.formal||=r.formal;v.hit||=matches(r,o,q);
   }
  }});if(shard.token!==tokens.find(([key])=>key===o.key)?.[1])throw Error('本地数据发生变化，请重新搜索');warnings.push(...shard.warnings);
 }
 const rows=[];let unidentified=0;
 for(const g of groups.values()){await tick();const versions=[...g.versions.values()],hits=versions.filter(v=>v.hit);if(!hits.length)continue;
  const chosen=hits.sort((a,b)=>Number(b.usable)-Number(a.usable)||Number(b.formal)-Number(a.formal)||a.version.localeCompare(b.version))[0],sources=chosen.sources,allSources=[...new Map(versions.flatMap(v=>v.sources).map(s=>[s.key,s])).values()];
  if(!g.id)unidentified++;rows.push({key:g.key,type:g.type,id:g.id,author:chosen.author,authorUid:chosen.authorUid,ms:chosen.ms,time:chosen.time,content:chosen.content,postId:chosen.postId,postText:chosen.postText,version:chosen.version,versions:versions.length,contextOnly:!sources.some(s=>s.formal),usable:chosen.usable,sources,allSources});
 }
 rows.sort((a,b)=>(b.ms??-Infinity)-(a.ms??-Infinity)||a.key.localeCompare(b.key));
 const final=C.objects(base);if(C.hash(final.objects.map(o=>[o.key,o.label,o.note]))!==C.hash(catalog.objects.map(o=>[o.key,o.label,o.note])))throw Error('对象资料发生变化，请重新搜索');
 for(const [k,t]of tokens){const o=final.objects.find(o=>o.key===k);if(!o||C.manifest(o).token!==t)throw Error('本地数据发生变化，请重新搜索');}
 return {state:warnings.length?'partial':'ready',rows,total:rows.length,exactTotal:rows.length-unidentified,unidentified,warnings:[...new Set(warnings)],credits:0,snapshot:C.hash(tokens),tokens,catalogToken:C.hash(catalog.objects.map(o=>[o.key,o.label,o.note])),queryText:q.text};
}
function assertSnapshot(base,result){
 if(!result?.tokens)throw Error('搜索结果已失效，请重新搜索');const stale=message=>Object.assign(Error(message),{code:'LOCAL_SEARCH_STALE'}),catalog=C.objects(base);if(result.catalogToken!==C.hash(catalog.objects.map(o=>[o.key,o.label,o.note])))throw stale('对象列表发生变化，请重新搜索');
 for(const [owner,token]of result.tokens){const obj=catalog.objects.find(x=>x.key===owner);if(!obj||C.manifest(obj).token!==token)throw stale('搜索后数据发生变化，请重新搜索');}
 return catalog;
}
async function resolve(base,result,key,sourceOwner,{currentOwner=false}={}){
 const hit=result?.rows.find(r=>r.key===key);if(!hit)throw Error('搜索结果已失效，请重新搜索');const catalog=currentOwner?C.objects(base):assertSnapshot(base,result),o=catalog.objects.find(o=>o.key===(sourceOwner||hit.sources[0]?.owner));if(!o)throw Error('所属对象已移除，请重新搜索');
 const s=hit.sources.find(s=>s.owner===o.key&&s.formal)||hit.sources.find(s=>s.owner===o.key);if(!s)throw Error('该对象未保存命中版本');const manifest=C.manifest(o),entry=manifest.files.find(e=>e.relative===s.file);if(!entry)throw Error('命中来源已移除');
 const rows=C.project(entry,o,{full:true}),row=rows.find(r=>r.version===hit.version&&r.recordId===hit.id&&r.channel===s.channel&&r.formal===s.formal);if(!row)throw Error('命中正文已变化');
 const anchor=row.formal?row:rows.find(r=>r.formal&&r.recordId===s.anchorId&&r.usable);if(!anchor?.usable||!anchor.recordId)throw Error('此旧内容缺少可导出的独立正文或可靠时间，请从所属对象查看已有数据');
 if(!currentOwner)assertSnapshot(base,result);if(C.manifest(o).token!==manifest.token||views.stamp(entry.file)?.signature!==(entry.sourceSignature||entry.signature))throw Object.assign(Error('命中来源正在提交，请等待当前保存边界'),{code:'LOCAL_SNAPSHOT_BUSY'});
 return {input:{target:o.id,mode:o.category==='posts'?'user-posts':o.category==='post-comments'?'post-comments':'comments-both',unlimited:true,markUnread:true},selection:{recordId:anchor.recordId,postId:anchor.postId,anchor:anchor.body,version:row.version,key:hit.key,matches:result.rows.filter(r=>r.sources.some(s=>s.owner===o.key)&&(anchor.postId?r.postId===anchor.postId:r.id===anchor.recordId)).map(r=>({id:r.id,version:r.version})),signature:require('../desktop/local-view').signature(o.dir)}};
}
module.exports={ensure,search,resolve,conditions,indexFile,metrics,assertSnapshot};
