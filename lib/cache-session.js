'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Task-local, never a process-global cache. Every reuse rechecks file identity;
// atomic replacement and edited snapshots invalidate bytes, parsed data and hash together.
function createCacheSession({maxBytes=Infinity}={}){
 let retainedBytes=0;const files=new Map(),normalized=new WeakMap();const stats={reads:0,bytes:0,parses:0,hashes:0};
 const identity=s=>[s.dev,s.ino,s.size,s.mtimeNs??s.mtimeMs,s.ctimeNs??s.ctimeMs].join('/');
 function regularStat(file){const s=fs.lstatSync(file,{bigint:true});if(!s.isFile()||s.isSymbolicLink())throw Object.assign(Error('本地来源不是可读取的普通文件'),{code:'LOCAL_SOURCE_INVALID'});return s;}
 function remember(file,bytes,raw,stat=regularStat(file)){
  const entry={bytes,raw,stamp:stat.mtimeNs==null?Number(stat.mtimeMs):Number(stat.mtimeNs)/1e6,identity:identity(stat),hash:crypto.createHash('sha256').update(bytes).digest('hex')};stats.hashes++;const key=path.resolve(file),old=files.get(key);if(old){retainedBytes-=old.bytes.length;files.delete(key);}if(bytes.length<=maxBytes){while(files.size&&retainedBytes+bytes.length>maxBytes){const first=files.keys().next().value;retainedBytes-=files.get(first).bytes.length;files.delete(first);}files.set(key,entry);retainedBytes+=bytes.length;}return entry;
 }
 function read(file){
  const key=path.resolve(file);
  for(let attempt=0;attempt<3;attempt++){
   const before=regularStat(file),old=files.get(key);
   if(old?.identity===identity(before)){if(identity(regularStat(file))===old.identity)return old;continue;}
   const bytes=require('./regular-file').read(file);stats.reads++;stats.bytes+=bytes.length;
   const after=regularStat(file);if(identity(before)!==identity(after))continue;
   const raw=JSON.parse(bytes.toString('utf8'));stats.parses++;return remember(file,bytes,raw,after);
  }
  throw Object.assign(Error('本地来源在读取期间持续变化，请稍后重试'),{code:'LOCAL_SOURCE_INVALID'});
 }
 function normalize(raw,kind,uid){
  let values=normalized.get(raw);if(!values){values=new Map();normalized.set(raw,values);}const key=kind+'/'+uid;
  if(!values.has(key))values.set(key,require('./core').normalize(raw,kind,uid));return values.get(key);
 }
 return {read,remember,normalize,stats,memory:()=>({retainedBytes,files:files.size,maxBytes})};
}
module.exports={createCacheSession};
