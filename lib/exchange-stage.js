'use strict';
// Private, immutable-byte staging. A sealed index is published only AFTER the
// append file has been synced. It is never content or continuity authority.
const fs=require('node:fs'),path=require('node:path'),S=require('./exchange-schema');
const MAX=128*1024*1024,TOTAL=4*1024*1024*1024,cache=new Map();
const indexFile=dir=>path.join(dir,'index.json'),dataFile=dir=>path.join(dir,'data.bin');
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join('/');
const invalid=message=>Object.assign(Error(message||'交换暂存不是可核实的普通文件'),{code:'LOCAL_SOURCE_INVALID'});
function identity(file){const s=fs.lstatSync(file,{bigint:true});if(!s.isFile()||s.isSymbolicLink())throw invalid();return stamp(s);}
function openRegular(file,write=false){
 let before;try{before=fs.lstatSync(file,{bigint:true});}catch(e){if(!write||e.code!=='ENOENT')throw e;}
 if(before&&(!before.isFile()||before.isSymbolicLink()))throw invalid();
 const flags=(write?fs.constants.O_RDWR:fs.constants.O_RDONLY)|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|(!before?fs.constants.O_CREAT|fs.constants.O_EXCL:0);let fd;
 try{fd=fs.openSync(file,flags,0o600);}catch(e){if(e.code==='ELOOP')throw invalid('交换暂存文件在打开时变化');throw e;}
 try{const opened=fs.fstatSync(fd,{bigint:true});if(!opened.isFile()||before&&stamp(opened)!==stamp(before))throw invalid('交换暂存文件在打开时变化');return {fd,opened};}catch(e){fs.closeSync(fd);throw e;}
}
function readBytes(file,range){
 const {fd,opened}=openRegular(file);try{
  const offset=range?.offset||0,size=range?.bytes??Number(opened.size);if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||size>MAX||offset+size>Number(opened.size))throw Error('交换暂存范围或长度无效');
  const out=Buffer.alloc(size);let at=0;while(at<size){const n=fs.readSync(fd,out,at,Math.min(65536,size-at),offset+at);if(!n)throw Error('交换暂存未完整保存');at+=n;}
  if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(opened)||identity(file)!==stamp(opened))throw invalid('交换暂存文件在读取时变化');return out;
 }finally{fs.closeSync(fd);}
}
function index(dir){const file=indexFile(dir);if(!fs.existsSync(file))return null;const stamp=identity(file),hit=cache.get(dir);if(hit?.stamp===stamp){cache.delete(dir);cache.set(dir,hit);return hit.value;}
 const envelope=JSON.parse(readBytes(file)),v=envelope.value;
 if(envelope.schema!==1||S.hash(JSON.stringify(v))!==envelope.sha256||v?.schema!==1||!Number.isSafeInteger(v.bytes)||v.bytes<0||v.bytes>TOTAL||!v.entries||Array.isArray(v.entries))throw Error('交换暂存索引损坏');
 const ranges=[];for(const [h,r]of Object.entries(v.entries)){if(!/^[a-f0-9]{64}$/.test(h)||!Number.isSafeInteger(r.offset)||!Number.isSafeInteger(r.bytes)||r.offset<0||r.bytes<0||r.bytes>MAX||r.offset+r.bytes>v.bytes)throw Error('交换暂存范围无效');ranges.push(r);}
 ranges.sort((a,b)=>a.offset-b.offset);let end=0;for(const r of ranges){if(r.offset!==end)throw Error('交换暂存范围不连续');end+=r.bytes;}if(end!==v.bytes)throw Error('交换暂存长度无效');identity(dataFile(dir));if(fs.statSync(dataFile(dir)).size<v.bytes)throw Error('交换暂存未完整保存');
 cache.set(dir,{stamp,value:v});while(cache.size>4)cache.delete(cache.keys().next().value);return v;
}
function get(dir,hash){if(!/^[a-f0-9]{64}$/.test(hash))throw Error('交换暂存哈希无效');const v=index(dir),r=v?.entries[hash];let bytes;
 if(r)bytes=readBytes(dataFile(dir),r);
 else bytes=readBytes(path.join(dir,hash));
 if(S.hash(bytes)!==hash)throw Error('交换暂存内容哈希损坏');return bytes;
}
function writer(dir,durable){fs.mkdirSync(dir,{recursive:true});if(fs.lstatSync(dir).isSymbolicLink())throw Error('交换暂存目录无效');const prior=index(dir),v=prior?{schema:1,bytes:prior.bytes,entries:{...prior.entries}}:{schema:1,bytes:0,entries:{}};let fd=null,dirty=!prior;
 const open=()=>{if(fd!==null)return;const value=openRegular(dataFile(dir),true);try{if(Number(value.opened.size)<v.bytes)throw Error('交换暂存未完整保存');fs.ftruncateSync(value.fd,v.bytes);fd=value.fd;}catch(e){fs.closeSync(value.fd);throw e;}};
 return {get(hash){const r=v.entries[hash];if(!r)return get(dir,hash);const b=readBytes(dataFile(dir),r);if(S.hash(b)!==hash)throw Error('交换暂存哈希损坏');return b;},put(bytes,hash=S.hash(bytes)){if(bytes.length>MAX||S.hash(bytes)!==hash)throw Error('交换暂存内容无效');if(v.entries[hash])return hash;const old=path.join(dir,hash);if(fs.existsSync(old)){get(dir,hash);return hash;}if(v.bytes+bytes.length>TOTAL)throw Error('交换暂存体积超过上限');open();let at=0;while(at<bytes.length){const n=fs.writeSync(fd,bytes,at,bytes.length-at,v.bytes+at);if(!n)throw Error('交换暂存写入未完成');at+=n;}v.entries[hash]={offset:v.bytes,bytes:bytes.length};v.bytes+=bytes.length;dirty=true;return hash;},
 seal(){if(!dirty)return;if(fd===null)open();require('./fs-sync').file(fd);fs.closeSync(fd);fd=null;durable(indexFile(dir),Buffer.from(JSON.stringify({schema:1,value:v,sha256:S.hash(JSON.stringify(v))})));cache.delete(dir);dirty=false;},
 close(){if(fd!==null){fs.closeSync(fd);fd=null;}}
 };
}
module.exports={get,writer};
