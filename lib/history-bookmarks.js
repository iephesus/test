'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {rawArray,normalize}=require('./core');
function fileFor(dir,kind,beforeMs){return path.join(dir,'cache','history-boundaries',kind+'_'+String(beforeMs)+'.json');}
function resolveSource(dir,ref,session=require('./cache-session').createCacheSession()){
 if(typeof ref.file!=='string'||!/^cache[\\/]/.test(ref.file)||!/^[a-f0-9]{64}$/.test(ref.hash||''))throw Error('历史区间证明来源无效');
 const root=fs.realpathSync(path.join(dir,'cache')),file=path.resolve(dir,ref.file);if(!file.startsWith(root+path.sep)&&!file.startsWith(path.resolve(dir,'cache')+path.sep))throw Error('历史证明路径越界');
 for(const candidate of [file,file.replace(/\.json$/,'_legacy_'+ref.hash.slice(0,16)+'.json')]){
  if(!fs.existsSync(candidate)||!fs.realpathSync(candidate).startsWith(root+path.sep))continue;
  const entry=session.read(candidate);if(entry.hash===ref.hash)return {raw:entry.raw?.schema===1&&entry.raw.query&&entry.raw.response?entry.raw.response:entry.raw,file:candidate};
 }
 throw Error('历史区间证明的原始响应已缺失或改变');
}
function saveBoundary(dir,kind,uid,beforeMs,boundary,index){
 const sources=index.sources;if(!sources.length)return;const file=fileFor(dir,kind,beforeMs);fs.mkdirSync(path.dirname(file),{recursive:true});
 const value={schema:1,uid,kind,beforeMs,strictHead:!!index.strictHead,boundaryId:boundary?String(boundary.idstr??boundary.id??boundary.mid):null,savedAt:new Date().toISOString(),sources};
 const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function reuseBoundary(dir,kind,uid,beforeMs,current){
 const file=fileFor(dir,kind,beforeMs);if(!fs.existsSync(file))return null;
 try{
  const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.schema!==1||value.uid!==uid||value.kind!==kind||value.beforeMs!==beforeMs||!Array.isArray(value.sources))throw Error('历史边界证明不匹配');
  if(current.strictHead&&!value.strictHead)throw Error('旧边界证明未包含严格首页与末尾校验，需重新核实');
  const {historyIndex,seekHistoryBoundary,historyNext}=require('./history'),proof=historyIndex(dir,kind,uid,false,{session:current.session,strictHead:!!value.strictHead}),resolved=[];
  for(const ref of value.sources){const packet=resolveSource(dir,ref,current.session);proof.add(packet.raw,ref.maxId,ref.sinceId,ref.time,ref.trustRange);resolved.push({...packet,ref});}
  for(const entry of current.records.values())proof.add({[kind==='mentions-posts'?'statuses':'comments']:[entry.raw]},entry.id.toString(),'',entry.cacheTimeMs,false);
  const read=(count,max='',since='')=>{let cursor=max;const seen=new Set();for(;;){const packet=proof.read(count,cursor,since);if(!packet)throw Error('已存证明未覆盖待验证的边界');packet.items=rawArray(packet.raw,kind).items;packet.nextCursor=historyNext(packet.raw,kind);if(packet.items.length||packet.nextCursor==='0')return packet;if(!packet.nextCursor||seen.has(packet.nextCursor))throw Error('历史证明续取链无效');seen.add(packet.nextCursor);cursor=packet.nextCursor;}};
  const boundary=seekHistoryBoundary(proof,beforeMs,read),key=boundary?String(boundary.idstr??boundary.id??boundary.mid):null;
  if(key!==value.boundaryId||(boundary&&normalize(boundary,kind,uid).ms>beforeMs))throw Error('历史边界证明与记录不一致');
  for(const {raw,ref,file:source}of resolved)current.add(raw,ref.maxId,ref.sinceId,ref.time,ref.trustRange,{file:source,responseHash:ref.hash});
  return {boundary,savedAt:value.savedAt,file};
 }catch(error){return {error:error.message};}
}
module.exports={saveBoundary,reuseBoundary,fileFor};
