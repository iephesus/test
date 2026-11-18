"use strict";
// Validate previously saved web-source evidence for local reports only.
const fs=require('node:fs'),path=require('node:path'),S=require('./exchange-schema'),regular=require('./regular-file');
// Legacy plain payloads remain readable and intact. New payloads are lossless
// compressed content; request hashes and the decompressed content hash stay
// unchanged. Bounds prevent a damaged compressed stream expanding indefinitely.
function payloadBytes(folder, hash) {
 const plain = path.join(folder, 'payloads', hash + '.json');
 const file = fs.existsSync(plain) ? plain : plain + '.gz';
 const stat = fs.lstatSync(file);
 if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error('网页订阅正文引用无效');
 const bytes = regular.read(file);
 const content = file.endsWith('.gz') ? require('node:zlib').gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }) : bytes;
 if (S.hash(content) !== hash) throw Error('网页订阅正文哈希不符');
 return content;
}
function read(file,empty){try{return JSON.parse(regular.read(file));}catch(e){if(e.code==='ENOENT')return empty;throw Object.assign(Error('已保存网页的进度无法核实'),{code:'LOCAL_SOURCE_INVALID'});}}
function scopeKey(scope,kind,id){if(!/^[a-f0-9-]{36}$/.test(scope)||!['post','post-follow','post-check','timeline'].includes(kind)||!/^\d{5,20}$/.test(id))throw Error('历史网页来源身份无效');return S.hash(S.stable({scope,kind,id,entry:'weibo.cn',source:'crawler'}));}
const postAvatarIndex=dir=>path.join(dir,'cache/crawler-author-avatar-v1.json');
function postAvatarIndexRead(dir){try{return JSON.parse(regular.read(postAvatarIndex(dir),{maxBytes:4096}));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function postResponseMatches(request,parsed,id){
 const links=require('./post-links');
 try {
  const url=new URL(request.url);
  if(url.hash || url.href!==request.url || [...url.searchParams].some(([key,value])=>!['page','uid','rl','filter'].includes(key)||!/^\d{1,20}$/.test(value)))return false;
 }catch{return false;}
 return links.crawlerPostPage(request.url,id)&&parsed.postId===id&&(parsed.bid==null||parsed.bid===links.postShortId(id))&&
  (parsed.source?.idstr==null||parsed.source.idstr===id)&&!(parsed.rows||[]).some(row=>row.postId&&row.postId!==id)&&
  request.status===200&&/^[a-f0-9]{64}$/.test(request.rawHash||'')&&Number.isFinite(Date.parse(request.receivedAt));
}
const wrongPost=()=>Object.assign(Error('评论响应与指定博文不一致，已保留诊断，未保存正文或推进位置'),{code:'LOCAL_SOURCE_INVALID'});
function postAvatar(request,parsed,id,bound=postResponseMatches(request,parsed,id)){
 const user=parsed.source?.user;
 if(!bound||parsed.sourceAuthorBound!==true||parsed.source?.idstr!==id||!/^[1-9]\d{4,19}$/.test(user?.idstr||''))return null;
 const avatarURL=require('./profile-image').imageURL(user.profile_image_url);
 if(!avatarURL||avatarURL.length>1024||new URL(avatarURL).hash)return null;
 return {uid:user.idstr,nickname:typeof user.screen_name==='string'?user.screen_name.slice(0,100):'',avatarURL};
}
// This optional locator carries no image address. The saved page receipt is
// the evidence and the only source used for an explicit avatar download.
function verifyPostAvatar(dir,id,ref){
 if(ref.schema!==1||ref.postId!==id||!['post','post-follow','post-check'].includes(ref.kind)||!/^[a-f0-9]{64}$/.test(ref.receipt?.hash||'')||!Number.isFinite(Date.parse(ref.at)))throw Error('头像出处无效');
 const {value}=open(dir,{scope:ref.scope,kind:ref.kind,id}).receipt(ref.receipt),author=postAvatar(value.request,value.parsed,id);
 if(!author||author.uid!==ref.uid||value.request.receivedAt!==ref.at)throw Error('头像出处身份不匹配');
 return author;
}
function readPostAvatar(dir,id,uid){
 try{
  const ref=postAvatarIndexRead(dir);if(!ref)return null;
  const author=verifyPostAvatar(dir,id,ref);
  return author.uid===uid?author:null;
 }catch(cause){throw Object.assign(Error('已保存的博文头像出处无法核验，原文件已保留',{cause}),{code:'LOCAL_PROFILE_SOURCE_INVALID'});}
}
function open(dir,{scope,kind,id}){
 const key=scopeKey(scope,kind,id),folder=path.join(dir,'cache/crawler-v1',key),stateFile=path.join(folder,'progress.json');
 const load=()=>{const v=read(stateFile,null);if(v&&(v.schema!==1||v.scope!==scope||v.id!==id||v.kind!==kind||v.entry!=='weibo.cn'))throw Error('已保存网页的进度与博文不匹配');if(v?.lastReceipt){const file=path.join(folder,v.lastReceipt.id+'.json');if(!/^[a-f0-9-]{36}$/.test(v.lastReceipt.id)||!fs.existsSync(file)||S.hash(regular.read(file))!==v.lastReceipt.hash)throw Error('已保存网页的响应证据缺失或损坏');}return v;};
 function receipt(proof){
  if(!/^[a-f0-9-]{36}$/.test(proof?.id||''))throw Error('响应引用身份无效');
  const file=path.join(folder,proof.id+'.json'),bytes=regular.read(file),hash=S.hash(bytes);if(proof.hash&&proof.hash!==hash)throw Error('响应引用哈希不符');
  const value=JSON.parse(bytes);if(![1,2].includes(value.schema)||value.request?.scope!==scope||value.request.id!==proof.id)throw Error('已保存网页的响应证据损坏');
  if(value.schema===2){if(!/^[a-f0-9]{64}$/.test(value.parsedRef||''))throw Error('响应正文引用损坏');const payload=payloadBytes(folder,value.parsedRef);value.parsed=JSON.parse(payload);value.parsed.firstIndependentIds=value.firstIndependentIds||[];}
  if(!value.parsed)throw Error('响应正文证据缺失');
  if(kind!=='timeline'&&!postResponseMatches(value.request,value.parsed,id))throw wrongPost();
  return {file,value,hash};
 }


 return {folder,load,receipt};
}
module.exports={open,scopeKey,readPostAvatar};
