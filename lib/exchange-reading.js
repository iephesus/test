'use strict';
// Read-only identity lookup for import unread decisions. Reuse the existing
// independent-body projection; it confers no acquisition/continuity authority.
const views=require('./file-view-cache'),sources=require('./inventory-sources');
async function existingCommentIds(dir,uid,kinds,wanted,{signal}={}){
 const owner={category:'user-comments',id:uid},manifest=()=>require('./inventory-index').manifest(dir,owner,{strict:true}),before=manifest(),found=new Set();
 const checkpoint=require('./local-work').checkpoint(signal,8);
 const invalid=()=>Object.assign(Error('本地评论阅读身份无法核实，未修改已读状态'),{code:'EXCHANGE_READING_SOURCE_INVALID'});
 for(const entry of before.files){
  await checkpoint();
  const role=sources.sourceKind(entry.relative,owner);if(!['receipt','snapshot','exchange',...kinds].includes(role))continue;
  if(views.stamp(entry.file)?.signature!==entry.signature)throw invalid();
  let contribution;try{
   // The portable-entry ceiling is not a limit on existing native responses
   // or report snapshots. Keep their established regular-file read policy.
   const bytes=require('./regular-file').read(entry.file,role==='exchange'?{maxBytes:128*1024*1024}:undefined);
   if(role==='snapshot'&&require('./exchange-schema').hash(bytes)!==require('node:path').basename(entry.relative,'.json'))throw invalid();
   contribution=sources.project(entry.relative,JSON.parse(bytes),owner,bytes,entry.file);
  }catch(error){throw invalid();}
  if(views.stamp(entry.file)?.signature!==entry.signature)throw invalid();
  for(const kind of kinds)for(const id of contribution[kind]?.bodies||[])if(wanted.has(id))found.add(id);
 }
 if(manifest().token!==before.token)throw invalid();return found;
}
module.exports={existingCommentIds};
