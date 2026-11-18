'use strict';
// Whitelisted saved-content projection shared by search and distribution views.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),S=require('./storage'),C=require('./core'),{exactId}=require('./completeness');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const key=o=>o.category+':'+o.id;
function objects(base){
 const p=S.storagePaths(base),out=[],warnings=[],regular=require('./regular-file');
 for(const category of ['user-comments','posts','post-comments']){
  const root=category==='post-comments'?p.postComments:category==='posts'?p.posts:p.users,index=S.indexRead(root),found=new Map();
  const indexFile=path.join(root,'.account_names.json');if(fs.existsSync(indexFile))try{const value=JSON.parse(regular.read(indexFile,{maxBytes:16*1024*1024}));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('格式无效');}catch{warnings.push(category+'：对象索引损坏，部分旧目录的身份无法确认');}
  for(const [id,v]of Object.entries(index))if(/^\d{5,20}$/.test(id))found.set(id,{id,dir:S.mappedFolder(root,id,index),label:String(v?.nickname||id)});
  const mappedPaths=new Set([...found.values()].map(o=>path.resolve(o.dir)));
  if(fs.existsSync(root))for(const e of fs.readdirSync(root,{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink()){
   const id=category==='post-comments'?S.postIdFromFolder(e.name):/^\d{5,20}$/.test(e.name)?e.name:'';if(!id&&!mappedPaths.has(path.resolve(root,e.name)))warnings.push(category+'：旧目录 '+e.name+' 缺少可靠对象身份，未纳入搜索');if(id&&!found.has(id))found.set(id,{id,dir:path.join(root,e.name),label:id});
  }
  for(const o of found.values())try{if(!fs.existsSync(o.dir))continue;const real=fs.realpathSync(o.dir);if(!real.startsWith(fs.realpathSync(root)+path.sep)||fs.lstatSync(o.dir).isSymbolicLink())throw Error('对象目录越界');out.push({...o,category,key:key({...o,category})});}catch(e){warnings.push(category+':'+o.id+'：'+e.message);}
 }
 // Notes only locate owners; they never determine identity or relationship.
 const read=f=>{try{return JSON.parse(regular.read(f,{maxBytes:16*1024*1024}));}catch{return {};}};
 const r=require('./data-layout').readerRoot(base),users=read(path.join(r,'users.json')).users||{},posts=read(path.join(r,'posts.json')).posts||{};
 for(const o of out){const local=o.category==='post-comments'?posts[o.id]:users[o.id];o.note=String(local?.note||'');o.label=String(local?.nickname||o.label);}
 return {objects:out.sort((a,b)=>a.key.localeCompare(b.key)),warnings};
}
function manifest(o){for(const part of ['','request-journal','report-snapshots','exchange-v1','data-updates']){const folder=path.join(o.dir,'cache',part);if(fs.existsSync(folder)&&fs.lstatSync(folder).isSymbolicLink())throw Error('本地来源目录为符号链接，未读取：'+part);}const m=require('./inventory-index').manifest(o.dir,o,{strict:true}),files=m.files.map(e=>e.relative.startsWith('exchange-v1/')?{...e,sourceSignature:e.signature,signature:e.signature+'|'+m.poolSignature}:e).filter(e=>!['gap','mentions-comments','mentions-posts'].includes(require('./inventory-sources').sourceKind(e.relative,o)));return {files,token:hash(files.map(e=>[e.relative,e.signature])),inventoryToken:m.token};}
function compact(r){const fields=['recordId','authorUid','author','content','postId','postAuthor','postAuthorUid','postText','time','ms','replyId','rootId'];const out=Object.fromEntries(fields.map(k=>[k,r[k]??(k==='ms'?null:'')]));out.recordId=exactId(r.recordId);out.postId=exactId(r.postId||r.id);out.authorUid=exactId(r.authorUid);out.ms=Number.isFinite(r.ms)?r.ms:null;return out;}
function version(r){return hash([r.recordId||'',r.authorUid||'',r.content||'',r.ms??null,r.postId||'']);}
function project(entry,o,{full=false,distribution=false}={}){
 if(fs.statSync(entry.file).size>64*1024*1024)throw Error('单个来源超过 64 MB，暂未纳入索引');
 const bytes=entry.relative.startsWith('exchange-v1/')?require('./exchange-records').bytes(entry.file):require('./regular-file').read(entry.file,{maxBytes:64*1024*1024});if(bytes.length>64*1024*1024)throw Error('单个来源超过 64 MB，暂未纳入索引');
 const raw=JSON.parse(bytes);
 // Unsafe numeric IDs cannot become rounded identities in the global index.
 function safeIds(v,depth=0){if(!v||typeof v!=='object')return;if(depth>24)throw Error('内容层级过深');for(const [k,x]of Object.entries(v)){if(/^(?:idstr|id|mid|uid|reply_id|rootid|status_id)$/.test(k)&&typeof x==='number'&&!Number.isSafeInteger(x)&&!(k!=='idstr'&&typeof v.idstr==='string'&&exactId(v.idstr)))throw Error('旧内容含精度不可靠的数值 ID，未纳入精确搜索');if(x&&typeof x==='object')safeIds(x,depth+1);}}
 safeIds(raw);const role=require('./inventory-sources').sourceKind(entry.relative,o),rows=[];let kind=role;
 function add(list,k){for(const r of list){if(!r||typeof r!=='object')continue;if(k==='sent'&&r.authorUid!==o.id||k==='user-posts'&&r.authorUid!==o.id)continue;if(distribution){if(!r.isContext)rows.push({recordId:exactId(r.recordId),channel:k,formal:true,usable:require('./record-body').completeBody(r),ms:Number.isFinite(r.ms)?r.ms:null});continue;}const c=compact(r);if(!c.content.trim())continue;const formal=!r.isContext;rows.push({...c,channel:k,formal,usable:formal&&require('./record-body').completeBody(r),version:version(c),...(full?{body:r}:{}),anchorId:r.isContext?'':c.recordId});}
  if(distribution||k==='user-posts')return;
  const formalRows=list.filter(r=>!r.isContext);
  for(const r of require('./reader').buildConversationRows(formalRows)){
   if(!r.isContext)continue;
   // Context references are indexes into the same formal rows passed to the renderer.
   const c=compact(r),anchorId=formalRows[r.contextFor?.[0]]?.recordId||'';
   rows.push({...c,channel:k,formal:false,usable:false,version:version(c),...(full?{body:r}:{}),anchorId});
  }
 }
 function packet(v,k){if(!['sent','received','post-comments','user-posts'].includes(k)||C.apiError(v))return;const a=C.rawArray(v,k);if(!a)throw Error('正文响应缺少数组');if(k==='post-comments')add(require('./post-comments').postPageRows(v,o.id).rows,k);else add(a.items.filter(x=>x&&typeof x==='object').map(x=>{const r=k==='user-posts'?require('./user-posts').normalizeUserPost(x):C.normalize(x,k,o.id);return {...r,...(x.isContext?{isContext:true}:{}),...(!require('./record-body').completeBody(r,x)?{bodyMissing:true}:{})};}),k);}
 if(role==='receipt'){if(raw.schema===1&&raw.query?.uid===o.id)packet(raw.response,raw.query.kind);}
 else if(role==='snapshot'){
  if(hash(bytes)!==path.basename(entry.relative,'.json')||raw.schema!==1||raw.uid!==o.id)throw Error('历史正文快照校验失败');
  for(const k of ['sent','received'])add((raw.rows||[]).filter(r=>k==='sent'?r.authorUid===o.id&&(r.group==='sent'||r.type==='发出/收到'||r.type==='发出'):r.group==='received'||r.type==='发出/收到'||r.type==='收到'),k);
 }else if(role==='exchange'){
  if(hash(bytes)!==path.basename(entry.relative,'.json'))throw Error('导入内容哈希损坏');
  if(raw.owner?.id===o.id&&raw.owner.kind===(o.category==='post-comments'?'post':'user')&&['sent','received','post-comments','user-posts'].includes(raw.channel)&&['records','packet'].includes(raw.role))add(require('./exchange-records').rowsOf(raw),raw.channel);
 }else if(role==='user-posts'){if(raw.query?.uid===o.id&&raw.endpoint==='statuses user_timeline/other')packet(raw.response,role);}
 else packet(raw,kind);
 return rows;
}
module.exports={objects,manifest,project,compact,version,hash,key};
