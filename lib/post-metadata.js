'use strict';
// Disposable list projection, never a body store or acquisition/continuity proof.
// Source identities are checked on every use; unchanged bodies are not parsed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readerRoot}=require('./data-layout'),{storagePaths,postIdFromFolder}=require('./storage');
const views=require('./file-view-cache'),regular=require('./regular-file');
const VERSION=2;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function inventory(dir){
 const cache=path.join(dir,'cache'),raw=views.manifest(cache,{filter:/^post-comments.*\.json$/,strict:true}),exchange=views.manifest(path.join(cache,'exchange-v1'),{filter:/^[a-f0-9]{64}\.json$/,strict:true});
 return {raw,signature:hash([raw.signature,exchange.signature,require('./exchange-store').signatureFor(dir)]),latestMs:raw.files.reduce((ms,f)=>Math.max(ms,f.mtimeMs),0)};
}
function compact(post,id){
 const core=require('./core');if(core.positiveId(post?.idstr,post?.id,post?.mid)!==id)return null;
 const text_raw=String(post.text_raw||post.text||'').replace(/<[^>]*>/g,'').slice(0,160),screen_name=core.userName(post.user);
 if(!screen_name)return text_raw?{text_raw}:null;
 return {text_raw,user:{idstr:core.userId(post.user),screen_name}};
}
function source(dir,id,manifest){
 const core=require('./core');
 // Preserve the established CLI-first lookup. mtime orders candidates only; it
 // does not claim a newer content version or establish a pagination boundary.
 for(const item of manifest.raw.files.filter(f=>/^post-comments_.*\.json$/.test(path.basename(f.file))).sort((a,b)=>b.mtimeMs-a.mtimeMs)){
  try{const raw=JSON.parse(regular.read(item.file));if(core.apiError(raw))continue;const parsed=core.rawArray(raw,'post-comments');for(const post of [raw?.status,raw?.weibo,raw?.data?.status,raw?.data?.weibo,...(parsed?.items||[]).flatMap(c=>[c.status,c.weibo])]){const value=compact(post,id);if(value?.user)return value;}}catch{}
 }
 let textOnly;
 for(const {value:v}of require('./exchange-records').iterateEntries(dir)){
  if(v.role!=='packet'||v.owner?.kind!=='post'||v.owner.id!==id)continue;const a=core.rawArray(v.response,'post-comments');for(const post of [v.response.status,v.response.weibo,...(a?.items||[]).flatMap(c=>[c.status,c.weibo])]){const value=compact(post,id);if(value?.user)return value;textOnly||=value;}
 }
 return textOnly||{};
}
function read(dir,id){
 if(!/^[1-9]\d{4,19}$/.test(id))throw Error('博文列表身份无效');
 const initial=inventory(dir),file=path.join(dir,'cache/view-indexes/post-home-v1.json');
 try{const saved=JSON.parse(regular.read(file,{maxBytes:32768}));if(saved.schema===1&&saved.version===VERSION&&saved.id===id&&saved.signature===initial.signature&&hash(saved.value)===saved.hash&&saved.value&&typeof saved.value.source==='object'&&saved.value.latestMs===initial.latestMs)return saved.value;}catch{}
 const value={source:source(dir,id,initial),latestMs:initial.latestMs};
 // Never commit a projection spanning an external replacement or an active save.
 if(inventory(dir).signature!==initial.signature)throw Object.assign(Error('博文资料正在变化，请稍后刷新'),{code:'LOCAL_VIEW_CHANGED'});
 try{const parent=path.dirname(file);if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw Error('派生目录包含符号链接');require('./update-progress').atomic(file,{schema:1,version:VERSION,id,signature:initial.signature,value,hash:hash(value)});}catch{/* Read-only/disk-full metadata caches do not lose the original data. */}
 return value;
}
const registryFile=base=>path.join(readerRoot(base),'posts.json');
function readRegistry(base){let value;try{value=views.readJSON(registryFile(base));}catch(error){if(error.code==='ENOENT')return {schema:1,posts:{}};throw Object.assign(Error('博文设置无法读取，原文件已保留'),{code:error.code||'LOCAL_SETTINGS_INVALID'});}if(value?.schema!==1||!value.posts||typeof value.posts!=='object'||Array.isArray(value.posts)||Object.entries(value.posts).some(([id,p])=>!/^\d{5,20}$/.test(id)||!p||typeof p!=='object'||Array.isArray(p)||p.postId&&p.postId!==id))throw Error('博文设置格式无效，原文件已保留');return value;}

// Desktop and exchange share typed post identities, labels and source precedence.
// Task history and acquisition status are projections of the desktop list.
function listMetadata(base){
 const entries=Object.fromEntries(Object.entries(readRegistry(base).posts).map(([id,post])=>[id,{post,latestMs:null}]));
 const root=storagePaths(base).postComments;
 if(fs.existsSync(root))for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  const postId=postIdFromFolder(entry.name);if(!postId)continue;
  const previous=entries[postId]?.post,{source,latestMs}=read(path.join(root,entry.name),postId);
  const title=String(source.text_raw||source.text||previous?.title||'微博 '+postId).replace(/<[^>]*>/g,'').slice(0,160);
  entries[postId]={post:{...previous,postId,title,author:source.user?.screen_name||'',authorUid:String(source.user?.idstr??source.user?.id??''),hasData:true},latestMs};
 }
 return Object.values(entries);
}
module.exports={read,readRegistry,registryFile,listMetadata};
