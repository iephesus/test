"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const storage=require('../lib/storage');
// Old ledgers may retain absolute paths from before a workspace or nickname
// rename. Resolve only the exact request's cache slot in its typed owner folder;
// hashes remain the authority, and the original ledger is never rewritten.
function verify(base,dir,q){
 const root=fs.realpathSync(base),inside=file=>fs.realpathSync(file).startsWith(root+path.sep);
 const original=path.isAbsolute(q.file)?q.file:path.resolve(dir,q.file);
 if(fs.existsSync(original)&&!inside(original))throw Error('原响应不在当前数据目录，未提交恢复结算');
 const matches=file=>fs.existsSync(file)&&inside(file)&&crypto.createHash('sha256').update(require('../lib/regular-file').read(file)).digest('hex')===q.hash;
 for(const file of [original,original.replace(/\.json$/,'_legacy_'+q.hash.slice(0,16)+'.json')])if(matches(file))return file;
 const normalized=q.file.replaceAll('\\','/'),tail=normalized.match(/(?:^|\/)cache\/([^/]+)$/)?.[1];
 if(tail&&['sent','received','post-comments'].includes(q.kind)){
  const expected=storage.cacheFile(dir,q.kind,q.count,q.maxId,q.sinceId,q.page||1);
  if(tail===path.basename(expected)){
   const packet=require('../lib/incremental').restorePacket({file:path.relative(dir,expected),hash:q.hash,count:q.count,maxId:q.maxId,sinceId:q.sinceId},dir);
   if(!inside(packet.file))throw Error('原响应不在当前数据目录，未提交恢复结算');
   return packet.file;
  }
 }
 throw Error('原响应哈希无法核实，未提交恢复结算');
}
module.exports={verify};
