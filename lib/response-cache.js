'use strict';
// Preserve the previous exact response before replacing its mutable cache slot.
// These snapshots are observations, never pagination or continuity authority.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),regular=require('./regular-file');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function preserve(file,bytes,stamp){
 const digest=hash(bytes),archive=file.replace(/\.json$/,'_legacy_'+digest.slice(0,16)+'.json');let fd;
 try{
  const sync=require('./fs-sync');
  try{fd=fs.openSync(archive,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,bytes);fs.futimesSync(fd,stamp,stamp);sync.file(fd);}
  catch(error){if(error.code!=='EEXIST')throw error;}
  finally{if(fd!=null)fs.closeSync(fd);}
  const saved=regular.read(archive);if(hash(saved)!==digest||!saved.equals(bytes))throw Error('旧响应备份内容与完整哈希不符');
  sync.path(archive);
  sync.directory(path.dirname(archive));
  if(!regular.read(archive).equals(bytes))throw Error('旧响应备份在核验期间变化');
  return archive;
 }catch(cause){throw Object.assign(Error('旧响应备份未能可靠保存，原缓存未替换'),{code:'REQUEST_EVIDENCE_INVALID',cause});}
}
function save(file,bytes){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 if(fs.existsSync(file)){
  const view=require('./file-view-cache'),before=view.stamp(file)?.signature,old=regular.read(file),stat=fs.statSync(file);
  if(view.stamp(file)?.signature!==before)throw Object.assign(Error('原响应在保存前变化，未覆盖缓存'),{code:'REQUEST_EVIDENCE_INVALID'});
  if(!old.equals(bytes))preserve(file,old,stat.mtime);
  if(view.stamp(file)?.signature!==before)throw Object.assign(Error('原响应在备份期间变化，未覆盖缓存'),{code:'REQUEST_EVIDENCE_INVALID'});
 }
 require('./durable-write').atomicBytes(file,bytes);
}
module.exports={save,preserve};
