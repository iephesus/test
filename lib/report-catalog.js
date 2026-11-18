'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {BASE}=require('./config'),{readerRoot,dataForReport,canonical}=require('./data-layout'),{atomic,read}=require('./auto-follow-budget');
// Report IDs are always relative to output/ and use `/`, so Windows path.relative
// backslashes never reach catalog validation or pin/open handoffs.
function normalizeId(id){return typeof id==='string'?id.replace(/\\/g,'/'):id;}
function idOf(base,file){
 const id=normalizeId(path.relative(canonical(path.join(base,'output')),canonical(file)));
 if(!id||id==='..'||id.startsWith('../')||path.isAbsolute(id)||id.includes('\0'))throw Error('报告目录越界');
 return id;
}
function entryOf(entries,id){
 const n=normalizeId(id);if(!n)return undefined;
 if(Object.prototype.hasOwnProperty.call(entries,n))return entries[n];
 if(Object.prototype.hasOwnProperty.call(entries,id))return entries[id];
 const win=n.replace(/\//g,'\\');
 return Object.prototype.hasOwnProperty.call(entries,win)?entries[win]:undefined;
}
function putEntry(catalog,id,value){
 const n=normalizeId(id),win=n.replace(/\//g,'\\');
 catalog.entries[n]=value;if(win!==n)delete catalog.entries[win];
}
function metadata(base=BASE){return read(path.join(readerRoot(base),'report-catalog.json'),{schema:1,entries:{}});}
function saveUnlocked(file,o,rows,label){const base=o.workspace||BASE,id=idOf(base,file);const catalog=metadata(base);putEntry(catalog,id,{...(o.localKey?{localKey:o.localKey}:{}),...(o.localHash?{localHash:o.localHash}:{}),uid:o.uid,...(o.postId?{postId:o.postId}:{}),account:label,...(o.merged?{merged:true}:{}),mode:o.mode,count:rows.length,before:'',from:o.from||'',to:o.to||'',partial:!!o.reportPartial,database:!!o.database,batch:!!o.batch,scope:o.unread?'未读互动':require('./date-range').label(o.from,o.to,o.database?'全部已保存日期':'互动'),modeLabel:o.mode==='user-posts'?'微博':o.mode==='post-comments'?'微博评论':o.mode.startsWith('mentions-')?'提及记录':'互动',collection:o.mode+'|'+(o.from||'')+'|'+(o.to||'')+(o.database?'|local':''),modified:fs.statSync(file).mtimeMs});atomic(path.join(readerRoot(base),'report-catalog.json'),catalog);
 if(o.uid&&['sent','received','both','all','mentions-comments','mentions-posts'].includes(o.mode)){const bytes=JSON.stringify({schema:1,uid:o.uid,rows:rows.filter(r=>!r.isContext)}),hash=crypto.createHash('sha256').update(bytes).digest('hex'),folder=path.join(dataForReport(base,path.dirname(file)),'cache/report-snapshots');fs.mkdirSync(folder,{recursive:true});const target=path.join(folder,hash+'.json');if(!fs.existsSync(target))require('./durable-write').atomicBytes(target,Buffer.from(bytes));catalog.entries[id].snapshot=hash;atomic(path.join(readerRoot(base),'report-catalog.json'),catalog);}
}
function privateRows(base,file,uid){try{const id=idOf(base,file),hash=entryOf(metadata(base).entries,id)?.snapshot;if(!/^[a-f0-9]{64}$/.test(hash||''))return null;const f=path.join(dataForReport(base,path.dirname(file)),'cache/report-snapshots',hash+'.json'),bytes=require('./regular-file').read(f);if(crypto.createHash('sha256').update(bytes).digest('hex')!==hash)return null;const value=JSON.parse(bytes);return value.uid===uid?value.rows:null;}catch{return null;}}
function save(file,o,rows,label){return require('./report-lifecycle').locked(o.workspace||BASE,()=>saveUnlocked(file,o,rows,label));}
function contained(base,id){
 id=normalizeId(id);
 if(typeof id!=='string'||!id||path.isAbsolute(id)||id.includes('\\')||id.includes('\0')||!id.endsWith('.html')||id.split('/').includes('..'))throw Error('报告路径无效');
 const output=path.resolve(base,'output'),file=path.resolve(output,id),s=fs.lstatSync(file);if(!file.startsWith(output+path.sep)||!s.isFile()||s.isSymbolicLink()||!canonical(file).startsWith(canonical(output)+path.sep))throw Error('报告路径越界');return file;
}
function owner(id,entry){id=normalizeId(id);const category=id.split('/')[0],value=category==='post-comments'?entry.postId||require('./storage').postIdFromFolder(id.split('/')[1]):entry.uid;return /^(?:user-comments|posts|post-comments)$/.test(category)&&typeof value==='string'&&/^\d{5,20}$/.test(value)?(category==='post-comments'?'post:':'user:')+value:'';}
function managedReports(base,requestedOwner=''){const entries=metadata(base).entries,out=[];for(const [raw,e]of Object.entries(entries)){const id=normalizeId(raw),typed=owner(id,e);if(!typed||requestedOwner&&typed!==requestedOwner)continue;try{const file=contained(base,id);out.push({...e,id,category:id.split('/')[0],modified:fs.statSync(file).mtimeMs});}catch{}}return out.sort((a,b)=>b.modified-a.modified);}
function queryOwner(o){const post=o?.mode==='post-comments',id=post?o.postId:o?.uid;return typeof id==='string'&&/^\d{5,20}$/.test(id)?(post?'post:':'user:')+id:'';}
function reusable(base,key,o){if(typeof key!=='string'||!key)return '';const requestedOwner=queryOwner(o);if(o!==undefined&&!requestedOwner)return '';const seen=new Set();for(const e of managedReports(base,requestedOwner)){const k=owner(e.id,e);if(seen.has(k))continue;seen.add(k);if(e.localKey===key&&/^[a-f0-9]{64}$/.test(e.localHash||''))try{const bytes=require('./regular-file').read(contained(base,e.id));if(crypto.createHash('sha256').update(bytes).digest('hex')===e.localHash)return e.id;}catch{}}return '';}
let renderer;
// Explicit render inputs, including helpers serialized into the standalone HTML.
// Acquisition and filesystem loaders are not recursively fingerprinted: selected data is in contentKey.
const RENDER_MODULES=['config','date-range','search-text','core','comment-media','comment-order','reader','reader-runtime','reader-templates','reader-layout','reader-paged','reader-assets','reader-colors','reader-visual','reader-mobile','posts-reader','post-links','post-ownership','share-report','report-records','report-name','records','limits','collection-result','completeness','record-availability','local-database'];
function renderIdentity(){return renderer??=crypto.createHash('sha256').update(RENDER_MODULES.map(n=>n+':'+crypto.createHash('sha256').update(fs.readFileSync(require.resolve('./'+n))).digest('hex')).join('|')).digest('hex');}
function contentKey(o,rows,meta,label){const options=Object.fromEntries(['uid','postId','mode','from','to','beforeMs','count','shareReport','markUnread','peerUid','lazyConversations','updateInfo','mergeInfo','recoveryInfo','conversationContext'].map(k=>[k,o[k]]));return crypto.createHash('sha256').update(JSON.stringify({renderer:renderIdentity(),options,rows,meta:meta.map(({rows,...rest})=>rest),label})).digest('hex');}
function relocation(base,from){
 const output=canonical(path.join(base,'output')),folder=normalizeId(path.relative(output,canonical(from))),entries=[];for(const [raw,meta]of Object.entries(metadata(base).entries)){const id=normalizeId(raw);if(normalizeId(path.dirname(id))===folder)try{entries.push({id,meta,hash:crypto.createHash('sha256').update(require('./regular-file').read(contained(base,id))).digest('hex')});}catch{}}
 return to=>{if(!entries.length)return;const folder=normalizeId(path.relative(output,canonical(to))),dest=new Map(),used=new Set();for(const file of require('./regular-file').list(to,/\.html$/)){const hash=crypto.createHash('sha256').update(require('./regular-file').read(file)).digest('hex'),rel=normalizeId(path.join(folder,path.basename(file)));if(!dest.has(hash))dest.set(hash,[]);dest.get(hash).push(rel);}const catalog=metadata(base);let changed=false;for(const e of entries){const candidates=dest.get(e.hash)||[],exact=normalizeId(path.join(folder,path.basename(e.id))),id=candidates.includes(exact)&&!used.has(exact)?exact:candidates.find(id=>!used.has(id));if(!id)continue;used.add(id);putEntry(catalog,id,e.meta);if(normalizeId(e.id)!==id){delete catalog.entries[e.id];delete catalog.entries[normalizeId(e.id)];delete catalog.entries[e.id.replace(/\//g,'\\')];}changed=true;}if(changed)atomic(path.join(readerRoot(base),'report-catalog.json'),catalog);};
}
const preparations=new Map(),writtenFiles=new Map();
function recordWritten(base,file){const files=writtenFiles.get(base)||[];files.push(idOf(base,file));writtenFiles.set(base,files.slice(-64));}
function written(base){return [...(writtenFiles.get(base)||[])];}
function takePrepared(file){const value=preparations.get(path.resolve(file));preparations.delete(path.resolve(file));return value;}
function reserve(base,file,o){if(o.openReport&&!o.dryRun){const id=idOf(base,file),pin=require('./report-lifecycle').pin(base,id,{prepared:true});preparations.set(path.resolve(file),pin);}}
function write(file,o,rows,label,render,key){return require('./report-lifecycle').locked(o.workspace||BASE,()=>{
 const base=o.workspace||BASE,existing=key&&reusable(base,key,o);if(existing){const file=contained(base,existing);reserve(base,file,o);recordWritten(base,file);return {file,reused:true};}
 const folder=canonical(path.dirname(file));if(!folder.startsWith(canonical(path.join(base,'output'))+path.sep))throw Error('报告目录越界');
 const html=render(),names=require('./report-name'),first=path.join(path.dirname(file),names.fileName(label,o,rows.length));
 // Exclusive creation also rejects dangling links and externally created files.
 // Never replace an older, pinned, edited or otherwise unproven report.
 file=names.writeExclusive(first,html);
 save(file,{...o,...(key?{localKey:key,localHash:crypto.createHash('sha256').update(html).digest('hex')}:{} )},rows,label);reserve(base,file,o);recordWritten(base,file);return {file,reused:false};
});}
const timers=new Map(),observers=new Map(),readyChecks=new Map(),paused=new Set();
function pauseMaintenance(base){paused.add(base);clearTimeout(timers.get(base));timers.delete(base);}
function observeMaintenance(base,notify,{canRun=()=>true}={}){observers.set(base,notify);readyChecks.set(base,canRun);return ()=>{if(observers.get(base)===notify){observers.delete(base);readyChecks.delete(base);}};}
const startupMaintenance=new Set();
function resumeMaintenance(base){paused.delete(base);if(!startupMaintenance.has(base)){startupMaintenance.add(base);defer(base,[],{allOwners:true});}const folder=path.join(base,'data/.reader/report-access/maintenance');if(fs.existsSync(folder)&&fs.readdirSync(folder).some(n=>/^[a-f0-9-]{36}\.json$/.test(n)))schedule(base,250);}
function defer(base,protect=[],{allOwners=false}={}){
 const folder=path.join(require('./report-lifecycle').root(base),'maintenance'),id=crypto.randomUUID();
 require('./update-progress').atomic(path.join(folder,id+'.json'),{schema:1,id,createdAt:Date.now(),protect:[...new Set(protect)],...(allOwners?{allOwners:true}:{})});schedule(base,250);return {deferred:true};
}
function schedule(base,delay){if(paused.has(base)||timers.has(base))return;const timer=setTimeout(()=>{timers.delete(base);if(!fs.existsSync(base))return;try{maintainPending(base);}catch(error){if(error.code==='DATA_LOCK_BUSY')schedule(base,2000);}},delay);timer.unref();timers.set(base,timer);}
function maintainPending(base){
 if(paused.has(base))return {removed:0,skipped:0,deferred:true};
 if(readyChecks.has(base)&&!readyChecks.get(base)()){schedule(base,1000);return {removed:0,skipped:0,deferred:true};}
 const folder=path.join(require('./report-lifecycle').root(base),'maintenance');
 const observer=observers.get(base),writeId='report-maintenance:'+crypto.randomUUID();let unlock,started=false;try{if(observer){observer({requestId:writeId,busy:true});started=true;}unlock=require('./workspace-access').enter(base,'writer');return require('./report-lifecycle').locked(base,()=>{
  const files=require('./regular-file').list(folder,/^[a-f0-9-]{36}\.json$/);if(!files.length)return {removed:0,skipped:0};
  const requests=files.map(file=>{const value=JSON.parse(require('./regular-file').read(file));if(value.schema!==1||!Array.isArray(value.protect)||!Number.isFinite(value.createdAt))throw Error('报告延迟维护记录无效，原文件保留');return {...value,file};}).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  const catalog=metadata(base).entries,byOwner=new Map();for(const r of requests){const grouped=new Map();for(const raw of r.protect){const id=normalizeId(raw),k=owner(id,entryOf(catalog,id)||{});if(!k)continue;if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(id);}for(const [k,ids]of grouped)byOwner.set(k,ids);}
  const reports=require('../desktop/library').listReports(base,{includeDatabase:false});if(requests.some(r=>r.allOwners===true))for(const report of reports){const key=owner(report.id,report);if(key&&!byOwner.has(key))byOwner.set(key,[]);}
  if(!byOwner.size){for(const request of requests)fs.unlinkSync(request.file);return {removed:0,skipped:0};}
  const protect=[...byOwner.values()].flat(),result=require('./report-retention').cleanupReports(base,{keep:1,perOwner:true,protect,listReports:()=>reports,containedReport:contained,scopeOwners:[...byOwner.keys()],queueMaintenance:false});
  if(result.deferred){schedule(base,1000);return result;}for(const request of requests)fs.unlinkSync(request.file);return result;
 });}catch(error){if(error.code!=='DATA_LOCK_BUSY')throw error;schedule(base,250);return {removed:0,skipped:0,deferred:true};}finally{unlock?.();if(started)observer({requestId:writeId,busy:false});}
}
module.exports={normalizeId,idOf,entryOf,metadata,save,privateRows,contained,owner,managedReports,reusable,renderIdentity,contentKey,write,defer,maintainPending,takePrepared,written,observeMaintenance,resumeMaintenance,pauseMaintenance,relocation};
