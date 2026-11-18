'use strict';
// Imported bodies are supplemental records. Only validated packets are scan evidence.
const fs=require('node:fs'),path=require('node:path');
const S=require('./exchange-schema'),views=require('./file-view-cache'),merge=require('./exchange-merge');
const bytes=file=>require('./exchange-store').read(file);
const folder=dir=>path.join(dir,'cache/exchange-v1');
function* iterateEntries(dir){
 const root=folder(dir),m=views.manifest(root,{filter:/^[a-f0-9]{64}\.json$/,strict:true}),namespace='exchange-entry:'+require('./exchange-store').signatureFor(dir);
 for(const {file}of m.files){const value=views.fileView(file,namespace,(v,meta)=>{const raw=require('./exchange-store').isReference(v)?bytes(file):meta.bytes;if(S.hash(raw)!==path.basename(file,'.json'))throw Error('导入内容哈希损坏');return JSON.parse(raw);});yield {value,file,hash:path.basename(file,'.json')};}
}
function entries(dir){return [...iterateEntries(dir)];}
function validatePacket(value){
 const o=S.owner(value.owner),kind=S.channel(o,value.channel),q=S.query(value.query,o,kind);
 if(!S.sameJSON(q,value.query)||!S.sameJSON(S.response(value.response,kind),value.response))throw Error('响应包含不支持或私人字段');
 if(!Number.isFinite(Date.parse(value.savedAt)))throw Error('响应缺少原始保存时间');
 const {rawArray,normalize,userId}=require('./core'),a=rawArray(value.response,kind);
 if(a.items.length>q.count)throw Error('响应超过请求上限');
 if(kind==='user-posts'){
  const p=require('./options').options([o.id,'user-posts',...(q.from?['--from',q.from]:[]),...(q.to?['--to',q.to]:[]),'--dry-run']);let previous=null;
  for(const raw of a.items){const r=require('./user-posts').normalizeUserPost(raw);if(userId(raw.user)!==o.id||r.ms<p.startMs||r.ms>p.endMs||q.maxId&&BigInt(r.id)>BigInt(q.maxId)||previous&&BigInt(r.id)>BigInt(previous))throw Error('博文响应的身份、日期或游标不匹配');previous=r.id;}
 }else{
  require('./history').historyIndex('',kind,o.id,false,{strictHead:true,conservativeTerminal:true}).add(value.response,q.maxId,q.sinceId,Date.parse(value.savedAt),false);
  if(q.sinceId&&a.items.some(r=>BigInt(S.id(r.idstr??r.id))<=BigInt(q.sinceId)))throw Error('响应未遵守独占新增边界');
  if(kind==='post-comments')require('./post-comments').postPageRows(value.response,o.id);
 }
 return {owner:o,kind,query:q};
}
function rowsOf(value){
 if(value.role==='records')return value.rows.map(r=>({...r}));
 const {rawArray,normalize}=require('./core'),o=value.owner,k=value.channel;
 const flags=(r,raw)=>({...r,...(raw.isContext?{isContext:true}:{}),...(!require('./record-body').completeBody(r,raw)?{bodyMissing:true}:{})});
 if(k==='post-comments'){const raw=new Map();function collect(list){for(const r of list){raw.set(require('./completeness').exactId(r.idstr??r.id),r);for(const k of ['comments','replies','children'])collect(Array.isArray(r[k])?r[k]:require('./core').rawArray(r[k],k)?.items||[]);}}collect(rawArray(value.response,k).items);return require('./post-comments').postPageRows(value.response,o.id).rows.filter(r=>r.recordId).map(r=>flags(r,raw.get(r.recordId)||{}));}
 if(k==='user-posts')return rawArray(value.response,k).items.filter(r=>require('./core').userId(r.user)===o.id).map(require('./user-posts').normalizeUserPost);
 return rawArray(value.response,k).items.filter(r=>require('./completeness').exactId(r.idstr??r.id??r.mid)).filter(r=>k!=='sent'||require('./core').userId(r.user)===o.id).map(r=>flags(normalize(r,k,o.id),r));
}
function packets(dir,kind,uid){return entries(dir).filter(({value:v})=>v.role==='packet'&&v.owner?.id===uid&&v.channel===kind&&v.trusted===true).flatMap(e=>{try{validatePacket(e.value);return [{...e,raw:e.value.response,cached:true,responseHash:e.hash,cacheTimeMs:Date.parse(e.value.savedAt),query:e.value.query,receipt:{file:path.relative(dir,e.file),hash:e.hash,envelope:true,uid,kind,count:e.value.query.count,maxId:e.value.query.maxId,sinceId:e.value.query.sinceId,page:e.value.query.page}}];}catch{return [];}});}
function versionsFromEntries(entries,dir,kind,uid,{contextsOnly=false}={}){
 const by=new Map();for(const e of entries){const v=e.value;if(!['packet','records'].includes(v.role)||v.owner?.id!==uid||v.channel!==kind)continue;
  for(const original of (v.role==='records'?v.rows:rowsOf(v))){if(contextsOnly&&!original.isContext)continue;const row=S.row(original,kind),id=row.recordId;const item={row,version:merge.version(row,kind),stamp:Date.parse(v.savedAt)||0,provenance:{type:'archive',file:path.relative(dir,e.file),responseHash:e.hash,savedAt:v.savedAt,exchange:true},sourceHash:e.hash};if(!by.has(id))by.set(id,new Map());const variants=by.get(id),same=[...variants.values()].find(old=>old.row.isContext===row.isContext&&!merge.conflict(old.row,row,kind));
   if(same){variants.delete(same.version);same.row=merge.merge(same.row,row,kind);same.stamp=Math.min(same.stamp,item.stamp);same.version=merge.version(same.row,kind);variants.set(same.version,same);}else variants.set(item.version,item);
  }
 }return by;
}
function versions(dir,kind,uid){return versionsFromEntries(iterateEntries(dir),dir,kind,uid);}
function selectVersions(by,preferred,kind,contexts=false){
 const output=new Map();for(const [id,variants]of by){const list=[...variants.values()].filter(e=>contexts?e.row.isContext:require('./record-body').completeBody(e.row)&&!e.row.truncated);if(!list.length)continue;const selected=list.find(e=>e.version===preferred[kind+':'+id]||S.hash(S.stable(e.row))===preferred[kind+':'+id])||list.sort((a,b)=>(a.stamp||Infinity)-(b.stamp||Infinity)||String(a.row.content||'').localeCompare(String(b.row.content||''))||String(a.row.authorUid||'').localeCompare(String(b.row.authorUid||'')))[0];output.set(id,selected);}return output;
}
function preferences(dir){
 let preferred={};try{preferred=JSON.parse(fs.readFileSync(path.join(folder(dir),'preferred.json'))).records||{};}catch{}
 return preferred;
}
function records(dir,kind,uid,{contexts=false}={}){
 return selectVersions(contexts?versionsFromEntries(iterateEntries(dir),dir,kind,uid,{contextsOnly:true}):versions(dir,kind,uid),preferences(dir),kind,contexts);
}
// A local report needs both the resolved versions and the explicit imported
// parents. Open each imported document once and reuse the original selector.
function projectUserArchive(dir,kinds,uid){
 const groups=new Map(kinds.map(kind=>[kind,{entries:[],knownIds:new Set()}]));
 const exact=require('./completeness').exactId;
 for(const entry of iterateEntries(dir)){
  const v=entry.value,group=groups.get(v.channel);
  if(!group||v.owner?.kind!=='user'||v.owner.id!==uid||!['packet','records'].includes(v.role))continue;
  const rows=v.role==='records'?v.rows:rowsOf(v);
  group.entries.push({...entry,value:{owner:v.owner,channel:v.channel,savedAt:v.savedAt,role:'records',rows}});
  for(const row of rows){if(!row.isContext){const id=exact(row.recordId);if(id)group.knownIds.add(id);}}
  const container=v.role==='packet'?require('./core').rawArray(v.response,v.channel)?.container:null;
  const missing=container?.miss_ids_str??container?.miss_ids;
  if(Array.isArray(missing))for(const value of missing){const id=exact(value);if(id)group.knownIds.add(id);}
 }
 const preferred=preferences(dir);
 return Object.fromEntries([...groups].map(([kind,{entries,knownIds}])=>{
  const variants=versionsFromEntries(entries,dir,kind,uid);
  return [kind,{knownIds,records:selectVersions(variants,preferred,kind),contexts:selectVersions(variants,preferred,kind,true)}];
 }));
}
function imageRows(rows,dir){
 return rows.map(r=>{const copy={...r},pictures=copy.pictures||copy.postPictures;
  if(pictures?.items){copy.localImages=[];for(const p of pictures.items){const prefix=S.hash(require('./core').pictureUrl(p.url));for(const ext of ['jpg','png','gif','webp','avif']){const f='images/'+prefix+'.'+ext;if(require('./image-cache').inspectImage(path.join(dir,f))){copy.localImages.push({file:f,url:p.url,bytes:fs.statSync(path.join(dir,f)).size});break;}}}}
  if(copy.repost)copy.repost=imageRows([copy.repost],dir)[0];return copy;
 });
}
module.exports={bytes,folder,entries,iterateEntries,validatePacket,rowsOf,packets,versions,versionsFromEntries,selectVersions,records,projectUserArchive,imageRows};
