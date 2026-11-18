'use strict';
// Content-addressed, lossless backing for portable evidence. File references
// retain the ORIGINAL JSON hash. This store is not a pagination authority.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const S=require('./exchange-schema'),codec=require('./exchange-store-codec');
const FORMAT='weibo-reader-content-ref',MAX=codec.MAX_ORIGINAL;
const chunkCache=new Map(),CHUNK_BYTES=16*1024*1024,CHUNK_ENTRIES=8192;let cachedBytes=0;
function cachedChunk(statement,identity,hash,maxBytes){const key=identity+'|'+hash,old=identity&&chunkCache.get(key);if(old){if(old.length>maxBytes)throw Error('共享内容展开长度超限');chunkCache.delete(key);chunkCache.set(key,old);return old;}const c=statement.get(hash);if(!c)throw Error('共享内容块缺失');const b=codec.inflateChunk(c.bytes,hash,maxBytes);if(identity&&b.length<=CHUNK_BYTES){while(chunkCache.size>=CHUNK_ENTRIES||cachedBytes+b.length>CHUNK_BYTES){const first=chunkCache.keys().next().value;cachedBytes-=chunkCache.get(first).length;chunkCache.delete(first);}chunkCache.set(key,b);cachedBytes+=b.length;}return b;}
function database(base){return path.join(require('./data-layout').readerRoot(base),'exchange-content-v1.sqlite');}
function baseFor(file,optional=false){let dir=path.dirname(path.resolve(file));for(let i=0;i<16;i++,dir=path.dirname(dir))if(['user-comments','post-comments','posts','.reader'].includes(path.basename(dir))&&['data','output'].includes(path.basename(path.dirname(dir))))return path.dirname(path.dirname(dir));if(optional)return null;throw Error('共享内容路径不属于资料目录');}
const generationFile=base=>database(base)+'.generation.json';
function fileStamp(base){try{const s=fs.statSync(database(base),{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join('/');}catch(e){if(e.code==='ENOENT')return 'absent';throw e;}}
function generation(base){
 try{const value=JSON.parse(require('./regular-file').read(generationFile(base),{maxBytes:4096}));if(value?.schema!==1||!/^[a-f0-9]{64}$/.test(value.id||'')||typeof value.stamp!=='string'||!value.stamp||value.stamp.length>256)throw Error('版本标记格式无效');return value;}
 catch(error){if(error.code==='ENOENT')return null;throw Object.assign(Error('共享内容版本标记无法核实，原始数据保留'),{code:'LOCAL_SOURCE_INVALID',cause:error});}
}
function signatureFor(file){const base=baseFor(file,true);return base?signature(base):'absent';}
function signature(base){const stamp=fileStamp(base);if(stamp==='absent')return stamp;const g=generation(base);return g?.stamp===stamp&&/^[a-f0-9]{64}$/.test(g.id||'')?g.id:S.hash(stamp);}
function seal(base,before){const current=fileStamp(base),g=generation(base),id=g?.stamp===before?g.id:require('node:crypto').randomBytes(32).toString('hex');require('./update-progress').atomic(generationFile(base),{schema:1,id,stamp:current});}
function open(base,write=false){const file=database(base);if(!write&&!fs.existsSync(file))throw Error('共享内容存储缺失，原始引用已保留');fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.lstatSync(path.dirname(file)).isSymbolicLink()||fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('共享内容路径包含符号链接');const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file,{readOnly:!write});if(write){db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS chunks(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS documents(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, recipe BLOB NOT NULL);');}return db;}
function isReference(v){return v?.format===FORMAT;}
function reference(bytes){return Buffer.from(JSON.stringify({schema:1,format:FORMAT,sha256:S.hash(bytes),bytes:bytes.length}));}
function putBatch(base,values){const before=fileStamp(base),db=open(base,true);let added=0;
 try{const known=db.prepare('SELECT size FROM documents WHERE hash=?'),chunk=db.prepare('SELECT 1 FROM chunks WHERE hash=?'),insert=db.prepare('INSERT OR IGNORE INTO chunks(hash,bytes) VALUES(?,?)'),document=db.prepare('INSERT INTO documents(hash,size,recipe) VALUES(?,?,?)'),seen=new Set(),identities=new Map();
 db.exec('BEGIN IMMEDIATE');try{for(const bytes of values){if(bytes.length>MAX)throw Error('共享内容超过上限');JSON.parse(bytes);const hash=S.hash(bytes);identities.set(hash,bytes.length);const old=known.get(hash);if(old){if(old.size!==bytes.length)throw Error('共享内容身份冲突');continue;}
 const encoded=codec.encode(bytes,(h,raw)=>{if(!seen.has(h)){if(!chunk.get(h))insert.run(h,zlib.deflateRawSync(raw));seen.add(h);}});document.run(hash,bytes.length,encoded.recipe);added++;
 }
 // Verify every new/previous document from the actual transaction's bytes
 // before COMMIT. No uncommitted chunk enters the process-wide read cache.
 for(const [hash,size]of identities)decode(db,hash,size,null);
 db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 if(added)seal(base,before);return added;
 }finally{db.close();}}
function put(base,bytes){return putBatch(base,[bytes])===1;}
function decoded(db,hash,size,identity){const doc=db.prepare('SELECT size,recipe FROM documents WHERE hash=?').get(hash),chunks=db.prepare('SELECT bytes FROM chunks WHERE hash=?');return codec.decode(doc,hash,size,(id,maxBytes)=>cachedChunk(chunks,identity,id,maxBytes));}
function decode(db,hash,size,identity){return decoded(db,hash,size,identity).bytes;}
function get(base,hash,size){if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(size)||size<0||size>MAX)throw Error('共享内容引用无效');const db=open(base);try{db.exec('BEGIN');return decode(db,hash,size,signature(base));}finally{db.close();}}
function read(file,bytes=require('./regular-file').read(file)){const v=JSON.parse(bytes);if(!isReference(v))return bytes;if(Object.keys(v).sort().join('|')!=='bytes|format|schema|sha256'||v.schema!==1)throw Error('共享内容引用格式无效');return get(baseFor(file),v.sha256,v.bytes);}
// Only retained per-owner references keep pooled documents alive. Never use a
// content index or progress maxima to decide what may be reclaimed.
function collect(base){if(!fs.existsSync(database(base)))return {removed:0};const live=new Map(),paths=require('./storage').storagePaths(base);
 for(const root of [paths.users,paths.posts,paths.postComments]){if(!fs.existsSync(root))continue;if(fs.lstatSync(root).isSymbolicLink())throw Error('共享正文对象根目录不可靠');for(const item of fs.readdirSync(root,{withFileTypes:true})){if(item.isSymbolicLink())throw Error('共享正文清理遇到不可靠对象路径');if(!item.isDirectory())continue;const cache=path.join(root,item.name,'cache');if(fs.existsSync(cache)&&fs.lstatSync(cache).isSymbolicLink())throw Error('共享正文对象缓存路径不可靠');const dir=path.join(cache,'exchange-v1');if(!fs.existsSync(dir))continue;if(fs.lstatSync(dir).isSymbolicLink())throw Error('共享正文引用目录不可靠');for(const name of fs.readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const file=path.join(dir,name);if(fs.lstatSync(file).isSymbolicLink())throw Error('共享正文引用不是普通文件');const bytes=require('./regular-file').read(file),ref=JSON.parse(bytes);let content;if(isReference(ref)){if(ref.schema!==1||Object.keys(ref).sort().join('|')!=='bytes|format|schema|sha256'||ref.sha256!==name.slice(0,-5))throw Error('共享正文引用格式或哈希无效');content=JSON.parse(get(base,ref.sha256,ref.bytes));live.set(ref.sha256,ref.bytes);}else{if(S.hash(bytes)!==name.slice(0,-5))throw Error('旧正文文件哈希无效，未回收共享内容');content=ref;}if(content.schema!==1||!['records','packet'].includes(content.role)||!content.owner||content.owner.kind!==(root===paths.postComments?'post':'user'))throw Error('共享正文来源格式或身份无法核实');const mapped=Object.entries(require('./storage').indexRead(root)).find(([,v])=>v.folder===item.name)?.[0],expected=mapped||require('./storage').postIdFromFolder(item.name);if(!expected||content.owner.id!==expected)throw Error('共享正文对象身份与目录不一致');S.owner(content.owner);S.channel(content.owner,content.channel);if(content.role==='records'){if(!Array.isArray(content.rows))throw Error('独立正文格式无效');for(const row of content.rows)S.row(row,content.channel);}else S.response(content.response,content.channel);}}}
 const before=fileStamp(base),db=open(base,true);let removed=0;try{
 db.exec('BEGIN IMMEDIATE');try{const docs=db.prepare('SELECT hash,size,recipe FROM documents').all(),used=new Set(),present=new Set(docs.map(d=>d.hash));
 for(const [hash,size]of live){if(!present.has(hash))throw Error('共享内容存储缺少保留的正文');for(const part of decoded(db,hash,size,null).parts)if(typeof part!=='string')used.add(part.chunk);}
 const dropDoc=db.prepare('DELETE FROM documents WHERE hash=?'),dropChunk=db.prepare('DELETE FROM chunks WHERE hash=?');for(const d of docs)if(!live.has(d.hash)){dropDoc.run(d.hash);removed++;}for(const c of db.prepare('SELECT hash FROM chunks').all())if(!used.has(c.hash))dropChunk.run(c.hash);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}if(removed)db.exec('VACUUM');seal(base,before);return {removed};}finally{db.close();}}
function metrics(base){const file=database(base);if(!fs.existsSync(file))return {documents:0,chunks:0,bytes:0};const db=open(base);try{return {documents:db.prepare('SELECT count(*) AS n FROM documents').get().n,chunks:db.prepare('SELECT count(*) AS n FROM chunks').get().n,bytes:fs.statSync(file).size,sharedTextBytes:db.prepare('SELECT coalesce(sum(length(bytes)),0) AS n FROM chunks').get().n,evidenceRecipeBytes:db.prepare('SELECT coalesce(sum(length(recipe)),0) AS n FROM documents').get().n};}finally{db.close();}}
module.exports={signatureFor,signature,database,baseFor,isReference,reference,put,putBatch,get,read,metrics,collect};
