'use strict';
// Disposable source-sized search projections. Never read an obsolete whole-owner
// text index into memory, and never retain the corpus across owner boundaries.
const fs=require('fs'),path=require('path'),C=require('./local-corpus'),V=require('./file-view-cache');
const VERSION=5,META_LIMIT=4*1024*1024,PART_LIMIT=8*1024*1024,CHUNK_TARGET=2*1024*1024;
function file(base,o){return path.join(require('./data-layout').readerRoot(base),'indexes/search-v1',C.hash(o.key)+'.json');}
function safeParents(base,name,create=false){
 const root=require('./data-layout').readerRoot(base),relative=path.relative(root,path.dirname(name));if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('搜索索引目录越界');
 let dir=root;for(const part of ['',...relative.split(path.sep).filter(Boolean)]){if(part)dir=path.join(dir,part);if(create&&!fs.existsSync(dir))fs.mkdirSync(dir);const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink())throw Error('搜索索引目录不是普通目录');}
}
function read(base,name,limit,namespace,validate,metrics){
 safeParents(base,name);const s=V.regularStamp(name);if(!s||s.size>limit)throw Error('搜索索引需要分批重建');
 const box=V.memo(namespace+'\0'+name,s.signature,()=>{
  let fd;try{
   const expected=fs.lstatSync(name,{bigint:true});fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const opened=fs.fstatSync(fd,{bigint:true});safeParents(base,name);
   if(!opened.isFile()||opened.dev!==expected.dev||opened.ino!==expected.ino||Number(opened.size)>limit)throw Error('搜索索引在读取时变化');
   const chunks=[];let size=0;for(;;){const b=Buffer.allocUnsafe(Math.min(65536,limit-size+1)),n=fs.readSync(fd,b,0,b.length,null);if(!n)break;size+=n;if(size>limit)throw Error('搜索索引超过读取上限');chunks.push(b.subarray(0,n));}
   if(V.regularStamp(name)?.signature!==s.signature)throw Error('搜索索引在读取时变化');metrics.indexReads++;const value=JSON.parse(Buffer.concat(chunks));if(!validate(value))throw Error('搜索索引校验失败');return value;
  }finally{if(fd!=null)fs.closeSync(fd);}
 });safeParents(base,name);if(V.regularStamp(name)?.signature!==s.signature)throw Error('搜索索引在读取时变化');return box;
}
function write(base,name,value){safeParents(base,name,true);require('./update-progress').atomic(name,value);}
function validRow(r){return r&&typeof r.content==='string'&&typeof r.version==='string'&&typeof r.postText==='string'&&typeof r.channel==='string';}
async function scanLocked(base,o,{signal,progress=()=>{},onSource=()=>{},metrics}={}){
 const tick=require('./local-work').checkpoint(signal,6),manifest=C.manifest(o),name=file(base,o),partRoot=path.join(path.dirname(name),'parts',C.hash(o.key));let previous={},previousValid=false;
 try{previous=read(base,name,META_LIMIT,'search-manifest-v5',b=>b.schema===2&&b.version===VERSION&&b.owner===o.key&&b.files&&b.hash===C.hash(b.files),metrics).files;previousValid=true;}catch{}
 const next={},warnings=[];let done=0;
 for(const entry of manifest.files){
  await tick();signal?.throwIfAborted();const sourceKey=C.hash([VERSION,o.key,entry.relative,entry.signature]),metaFile=path.join(partRoot,sourceKey+'.index.json');let meta=previous[entry.relative],reused=false;
  const valid=m=>m&&m.signature===entry.signature&&Array.isArray(m.parts)&&m.parts.length<=65536&&m.parts.every(p=>p&&/^[a-f0-9]{64}\.\d+\.json$/.test(p.name)&&p.name.startsWith(sourceKey+'.')&&/^[a-f0-9]{64}$/.test(p.hash));
  if(!valid(meta))try{const box=read(base,metaFile,256*1024,'search-source-meta-v5',b=>b.schema===1&&b.version===VERSION&&b.owner===o.key&&b.source===entry.relative&&valid(b.value)&&b.hash===C.hash(b.value),metrics);meta=box.value;}catch{meta=null;}
  const part=p=>read(base,path.join(partRoot,p.name),PART_LIMIT,'search-part-v5',b=>b.schema===1&&b.version===VERSION&&b.owner===o.key&&b.source===entry.relative&&b.signature===entry.signature&&Array.isArray(b.rows)&&b.rows.every(validRow)&&b.hash===p.hash&&b.hash===C.hash(b.rows),metrics).rows;
  if(valid(meta))try{for(const p of meta.parts){await tick();part(p);}reused=true;}catch{reused=false;}
  if(reused){metrics.reusedSources++;let offset=0;for(const p of meta.parts){await tick();const rows=part(p);await onSource(entry.relative,rows,offset);offset+=rows.length;}}
  else{
   metrics.sourceReads++;metrics.updatedSources++;let rows=[],warning='';try{rows=C.project(entry,o);}catch(error){warning=path.basename(entry.file)+'：'+error.message;}
   if(V.stamp(entry.file)?.signature!==(entry.sourceSignature||entry.signature))throw Error('本地数据正在变化，请重新搜索');
   const chunks=[];let chunk=[],size=0;for(const row of rows){const bytes=Buffer.byteLength(JSON.stringify(row))+1;if(chunk.length&&size+bytes>CHUNK_TARGET){chunks.push(chunk);chunk=[];size=0;}chunk.push(row);size+=bytes;}if(chunk.length)chunks.push(chunk);
   meta={signature:entry.signature,parts:[],warning};let saved=true;
   let offset=0;for(let i=0;i<chunks.length;i++){
    await tick();signal?.throwIfAborted();const rows=chunks[i],hash=C.hash(rows),value={schema:1,version:VERSION,owner:o.key,source:entry.relative,signature:entry.signature,rows,hash},partName=sourceKey+'.'+i+'.json';
    try{if(Buffer.byteLength(JSON.stringify(value))>PART_LIMIT)throw Error('单条搜索内容过大，未缓存');write(base,path.join(partRoot,partName),value);meta.parts.push({name:partName,hash});}catch{saved=false;}
    await onSource(entry.relative,rows,offset);offset+=rows.length;
   }
   if(saved)try{write(base,metaFile,{schema:1,version:VERSION,owner:o.key,source:entry.relative,value:meta,hash:C.hash(meta)});}catch{saved=false;}
   if(!saved)meta={signature:entry.signature,parts:null,warning};
  }
  if(meta.warning)warnings.push(meta.warning);next[entry.relative]=meta;done++;if(done%16===0)progress({object:o.key,done,total:manifest.files.length});
 }
 if(C.manifest(o).token!==manifest.token)throw Error('本地数据正在变化，请重新搜索');signal?.throwIfAborted();
 let committed=previousValid&&C.hash(previous)===C.hash(next)&&fs.existsSync(name);if(!committed)try{const value={schema:2,version:VERSION,owner:o.key,files:next,hash:C.hash(next)};if(Buffer.byteLength(JSON.stringify(value))>META_LIMIT)throw Error('索引清单过大');write(base,name,value);committed=true;}catch(error){warnings.push('搜索索引清单未能保存：'+error.message);}
 if(committed&&!warnings.length&&Object.values(next).every(v=>Array.isArray(v.parts))){signal?.throwIfAborted();if(C.manifest(o).token!==manifest.token)throw Error('本地数据正在变化，请重新搜索');try{
  const saved=read(base,name,META_LIMIT,'search-manifest-v5',b=>b.schema===2&&b.version===VERSION&&b.owner===o.key&&b.hash===C.hash(next)&&b.hash===C.hash(b.files),metrics),keep=new Set();for(const entry of manifest.files){const key=C.hash([VERSION,o.key,entry.relative,entry.signature]);keep.add(key+'.index.json');for(const p of saved.files[entry.relative].parts)keep.add(p.name);}
  if(fs.existsSync(partRoot)){safeParents(base,path.join(partRoot,'placeholder'));for(const e of fs.readdirSync(partRoot,{withFileTypes:true})){await tick();signal?.throwIfAborted();if(!e.isFile()||e.isSymbolicLink()||!/^[a-f0-9]{64}\.(?:index|\d+)\.json$/.test(e.name)||keep.has(e.name))continue;const f=path.join(partRoot,e.name),stat=fs.lstatSync(f);if(stat.isFile()&&!stat.isSymbolicLink())fs.unlinkSync(f);}}
 }catch(error){if(signal?.aborted)throw error;warnings.push('搜索旧索引清理未完成：'+error.message);}}
 return {owner:o,token:manifest.token,files:next,warnings};
}
async function scan(base,o,options={}){const name=file(base,o);safeParents(base,name,true);const lease=require('./process-lease').acquire(name+'.lock','此对象的搜索索引正在整理，请稍后重试');try{return await scanLocked(base,o,options);}finally{lease.release();}}
module.exports={scan,file,VERSION,META_LIMIT,PART_LIMIT};
