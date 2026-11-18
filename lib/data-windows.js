'use strict';
// Only validated server scan windows certify connections. Isolated record IDs
// (including imported snapshots) provide bodies, never continuity evidence.
const fs=require('node:fs'),path=require('node:path');
const {rawArray,apiError,userId}=require('./core');
const {historyNext,historyRecordId}=require('./history');
const {loadIndependentArchive}=require('./completeness');
const {completeBody}=require('./record-body');
function archivedBodies(archive,dir,kind,session){
 const bodies=new Map(archive.records),idsByFile=new Map();
 for(const [id,entry] of archive.records){
  if(!completeBody(entry.row)){bodies.delete(id);continue;}
  const file=entry.provenance.file;
  if(!idsByFile.has(file))idsByFile.set(file,new Set());
  idsByFile.get(file).add(id);
 }
 // Each source is read with the session's file-identity checks. The first raw
 // occurrence still supplies the body flags, including duplicate IDs in a page.
 for(const [file,ids] of idsByFile){
  let items;
  try{items=rawArray(session.read(path.resolve(dir,file)).raw,kind)?.items;}catch{continue;}
  for(const raw of items||[]){
   if(raw==null)break;
   const id=String(raw.idstr??raw.id??raw.mid);
   if(ids.delete(id)&&!completeBody(bodies.get(id).row,raw))bodies.delete(id);
   if(!ids.size)break;
  }
 }
 return bodies;
}
function createWindows(dir,kind,uid,session=require('./cache-session').createCacheSession()){
 const archive=loadIndependentArchive(dir,kind,uid,session),bodies=archivedBodies(archive,dir,kind,session),windows=[],probes=[],warnings=[];
 function add(packet,count,maxId='',sinceId='',trusted=true,{allowEcho=false}={}){
  const parsed=rawArray(packet.raw,kind);if(!parsed||apiError(packet.raw))throw Error(apiError(packet.raw)||'数据响应缺少记录数组');
  if(parsed.items.length>count)throw Error('返回数超过请求上限；原始响应保留，停止后续请求');
  const ids=parsed.items.map(historyRecordId),rows=parsed.items.map(r=>session.normalize(r,kind,uid));let prev=null;
  for(let i=0;i<ids.length;i++){
   const id=BigInt(ids[i]);if(maxId&&id>BigInt(maxId)||prev!=null&&id>prev)throw Object.assign(Error('接口未遵守分页边界或顺序，未推进读取位置'),{code:'PAGINATION_BOUNDARY'});if(sinceId&&id<=BigInt(sinceId))throw Object.assign(Error('接口未遵守分页下界，未推进读取位置'),{code:'SINCE_BOUNDARY_IGNORED'});prev=id;
   if(kind==='sent'&&userId(parsed.items[i].user)!==uid)throw Error('发出数据作者不匹配');
   if(!Number.isFinite(rows[i].ms))throw Error('记录日期无法识别，数据已保留，范围未核实');
  }
  const next=historyNext(packet.raw,kind),low=ids.at(-1)||null;
  const completeIds=new Set(ids.filter((id,i)=>completeBody(rows[i],parsed.items[i])));
  const echo=allowEcho&&kind==='received'&&!!maxId&&next===maxId&&ids.length>0&&
   new Set(ids).size===ids.length&&completeIds.size===ids.length&&BigInt(low)>1n&&BigInt(low)<BigInt(maxId);
  if(!echo&&next&&next!=='0'&&(maxId&&BigInt(next)>=BigInt(maxId)||low&&BigInt(next)>BigInt(low)))
   throw Object.assign(Error('接口游标未推进或与返回记录矛盾'),{code:'PAGINATION_BOUNDARY'});

  for(let i=0;i<ids.length;i++)if(completeIds.has(ids[i]))bodies.set(ids[i],{row:rows[i],stamp:packet.cacheTimeMs||Date.now(),provenance:{type:packet.cached?'cache':'api',file:packet.file?path.relative(dir,packet.file):'',responseHash:packet.responseHash||'',savedAt:new Date(packet.cacheTimeMs||Date.now()).toISOString()}});
  const floor=next&&next!=='0'?BigInt(next)+1n:low?BigInt(low):sinceId&&next==='0'?BigInt(sinceId)+1n:null;
  const upper=maxId?BigInt(maxId):ids.length?BigInt(ids[0]):null;
  const observedMissing=(parsed.container.miss_ids_str??parsed.container.miss_ids??[]);
  const window={packet,count,maxId,sinceId,ids,rows,completeIds,next,low,floor:echo?BigInt(low):floor,upper,echo,observedMissing:Array.isArray(observedMissing)?observedMissing.map(require('./completeness').exactId).filter(id=>id&&upper!=null&&next&&next!=='0'&&floor!=null&&BigInt(id)>=floor&&BigInt(id)<=upper&&(!sinceId||BigInt(id)>BigInt(sinceId))):[]};
  if(trusted&&maxId&&count===1&&!sinceId)probes.push(window);
  if(trusted&&!echo&&floor!=null&&upper!=null&&floor<=upper)windows.push(window);
  return window;
 }
 const cache=path.join(dir,'cache');if(fs.existsSync(cache))for(const name of fs.readdirSync(cache)){
  const m=name.match(new RegExp('^'+kind+'_c(\\d+)_m(\\d+)(?:_s(\\d+))?(_legacy_[a-f0-9]{16})?\\.json$'));
  if(!m&&name!==kind+'_page1.json')continue;
  try{const file=path.join(cache,name),e=session.read(file),packet={raw:e.raw,file,cached:true,responseHash:e.hash,cacheTimeMs:e.stamp};
   // Archive-only bytes cannot independently assert a scanned interval.
   add(packet,m?Number(m[1]):Math.max(1,rawArray(e.raw,kind)?.items.length||1),m?.[2]==='0'?'':m?.[2]||'',m?.[3]||'',!m?.[4]);
  }catch(error){warnings.push(name+'：'+error.message);}
 }
 const receipts=path.join(cache,'request-journal');if(fs.existsSync(receipts))for(const name of fs.readdirSync(receipts).filter(n=>n.endsWith('.response.json')))try{const file=path.join(receipts,name),e=session.read(file),b=e.raw;if(b.schema!==1||b.query?.uid!==uid||b.query.kind!==kind)continue;add({raw:b.response,file,cached:true,responseHash:e.hash,cacheTimeMs:e.stamp,receipt:{file:path.relative(dir,file),hash:e.hash,envelope:true,uid,kind,page:b.query.page}},b.query.count,b.query.maxId,b.query.sinceId,true);}catch(error){warnings.push(name+'：'+error.message);}
 // Targeted multi-ID checks are reusable observations, never continuity or
 // deletion proof. Their original scoped journal must bind the exact response.
 const journals=path.join(cache,'data-updates');if(fs.existsSync(journals))for(const name of fs.readdirSync(journals).filter(n=>new RegExp('^'+kind+'_[a-f0-9]{16}\\.json$').test(n)))try{
  const j=session.read(path.join(journals,name)).raw;if(j.schema!==1||j.uid!==uid||j.kind!==kind)continue;
  for(const check of j.missingBatches||[]){
   if(!Array.isArray(check.ids)||check.ids.some(id=>typeof id!=='string'||!/^\d+$/.test(id)))continue;
   const r=check.response;if(!r||!j.packets.some(p=>p.hash===r.hash&&p.file===r.file&&p.count===r.count&&p.maxId===r.maxId&&(p.sinceId||'')===(r.sinceId||'')))continue;
   const packet=require('./incremental').restorePacket(r,dir),box=JSON.parse(require('./regular-file').read(packet.file));
   if(box.schema===1&&box.query){const q=box.query;if(q.uid!==uid||q.kind!==kind||q.count!==r.count||q.maxId!==r.maxId||(q.sinceId||'')!==(r.sinceId||'')||q.page!==1||q.taskId!==j.id)continue;}
   else if(packet.file!==require('./storage').cacheFile(dir,kind,r.count,r.maxId,r.sinceId||'',1))continue;
   const w=add(packet,r.count,r.maxId,r.sinceId||'');
   w.recoveryIds=check.ids.filter(id=>id===w.maxId||w.floor!=null&&w.upper!=null&&BigInt(id)>=w.floor&&BigInt(id)<=w.upper);probes.push(w);
  }
 }catch(error){warnings.push(name+'：'+error.message);}
 const preferred=new Map(bodies);for(const p of require('./exchange-records').packets(dir,kind,uid))try{add({...p,file:p.file,imported:true},p.query.count,p.query.maxId,p.query.sinceId,rawArray(p.raw,kind).items.length>0||!!historyNext(p.raw,kind)&&historyNext(p.raw,kind)!=='0');}catch(error){warnings.push('导入区间：'+error.message);}for(const [id,e]of preferred)bodies.set(id,e);
 // Remove any placeholder body originally admitted by the legacy archive loader.
 for(const [id,e]of [...bodies])if(!completeBody(e.row))bodies.delete(id);
 function at(cursor,since='',{localProof=false}={}){
  if(!cursor)return null;const hi=BigInt(cursor),lower=BigInt(since||0);
  let best=null;
  for(const w of windows){
   if(localProof&&w.packet.imported||w.floor>hi||w.upper!=null&&w.upper<hi||since&&w.sinceId&&BigInt(w.sinceId)>lower)continue;
   if(!best||w.floor<best.floor||w.floor===best.floor&&w.packet.cacheTimeMs>best.packet.cacheTimeMs)best=w;
  }
  return best;
 }
 function missingProbe(id){return probes.filter(w=>(w.recoveryIds?.includes(id)||w.maxId===id&&!w.sinceId&&w.count===1&&(w.ids.includes(id)||w.ids.length||w.next!=null))).sort((a,b)=>(b.packet.cacheTimeMs||0)-(a.packet.cacheTimeMs||0))[0]||null;}
 function missingObservation(id){return windows.filter(w=>w.observedMissing.includes(id)&&Number.isFinite(w.packet.cacheTimeMs)&&Date.now()-w.packet.cacheTimeMs>=0&&Date.now()-w.packet.cacheTimeMs<5*60000).sort((a,b)=>b.packet.cacheTimeMs-a.packet.cacheTimeMs)[0]||null;}
 function point(cursor){return bodies.get(cursor)||null;}
 function latest(){return windows.filter(w=>!w.maxId&&!w.sinceId&&w.ids.length).sort((a,b)=>(b.packet.cacheTimeMs||0)-(a.packet.cacheTimeMs||0))[0]||null;}
 function bandBelow(cursor,since=''){
  const hi=cursor?BigInt(cursor):null,lower=BigInt(since||0);
  // Return an actual scanned band's top, not an arbitrary imported maximum ID.
  let best=null,bestId=lower;
  for(const w of windows){
   if(!w.ids.length)continue;
   const id=BigInt(w.ids[0]);
   if(id<=bestId||hi!=null&&id>=hi)continue;
   best={w,id:w.ids[0]};bestId=id;
  }
  return best;
 }
 return {archive,bodies,windows,warnings,add,at,missingProbe,missingObservation,point,latest,bandBelow,session};
}
module.exports={createWindows,completeBody};
