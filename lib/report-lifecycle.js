'use strict';
// Shared coordination for the existing report catalog, browser handoffs and
// retention. These leases protect files; they never authorize a read receipt.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),leases=require('./process-lease'),regular=require('./regular-file');
const held=new Set();
function root(base){require('./storage').validateLegacyControl(base);if(!fs.existsSync(base)||!fs.statSync(base).isDirectory())throw Error('原资料目录不存在，报告保护未修改');const canonical=require('./data-layout').canonical,scope=canonical(base),dir=path.join(scope,'data/.reader/report-access');if(!canonical(dir).startsWith(scope+path.sep))throw Error('报告保护目录越界');fs.mkdirSync(dir,{recursive:true});if(fs.lstatSync(dir).isSymbolicLink())throw Error('报告保护目录不能使用符号链接');return dir;}
function locked(base,fn){const dir=root(base);if(held.has(dir))return fn();const lease=leases.acquire(path.join(dir,'catalog.lock'),'报告正在由另一进程准备、打开或清理，请稍后重试');held.add(dir);try{return fn();}finally{held.delete(dir);lease.release();}}
function resume(base){const timer=setTimeout(()=>{try{require('./report-catalog').maintainPending(base);}catch{/* The durable request remains available for the next retry. */}},0);timer.unref();}
function pins(base,now=Date.now()){
 return locked(base,()=>{
  const dir=path.join(root(base),'pins');if(!fs.existsSync(dir))return [];
  const files=regular.list(dir,/^[a-f0-9-]{36}\.json$/),known=new Set(files.map(f=>path.basename(f,'.json'))),result=[];
  for(const entry of fs.readdirSync(dir)){const m=entry.match(/^([a-f0-9-]{36})\.lock$/);if(m&&!known.has(m[1])&&leases.active(path.join(dir,entry)))throw Error('报告保护记录尚未完整保存，旧报告保留');}
  for(const file of files){const token=path.basename(file,'.json'),box=JSON.parse(regular.read(file));if(box.schema!==1||box.token!==token||typeof box.id!=='string'||!Number.isFinite(box.expires)||!/^[a-f0-9]{64}$/.test(box.hash)||typeof box.leaseId!=='string')throw Error('报告保护记录无效，旧报告保留');
   const intent=file.replace(/\.json$/,'.release.json');let release=false;if(fs.existsSync(intent)){const value=JSON.parse(regular.read(intent));if(value.schema!==1||value.token!==token||value.leaseId!==box.leaseId||value.id!==box.id||value.hash!==box.hash)throw Error('报告释放凭据不匹配，旧报告保留');release=true;}
   const active=leases.active(path.join(dir,token+'.lock'));if(!active&&(release||!box.prepared||now>=box.expires)){fs.unlinkSync(file);if(release)fs.unlinkSync(intent);continue;}
   if(!release&&now<box.expires)result.push(box);
  }
  return result;
 });
}
function pin(base,id,{ttlMs=15*60000,onExpire=()=>{},prepared=false}={}){
 return locked(base,()=>{
  const file=require('./report-catalog').contained(base,id),hash=crypto.createHash('sha256').update(regular.read(file)).digest('hex'),token=crypto.randomUUID(),dir=path.join(root(base),'pins'),lease=leases.acquire(path.join(dir,token+'.lock')),record=path.join(dir,token+'.json'),expires=Date.now()+ttlMs;
  try{require('./update-progress').atomic(record,{schema:1,token,id,hash,expires,prepared,leaseId:lease.id});}catch(error){lease.release();throw error;}
  let released=false,timer,expired=false,retries=0;
  const intent=record.replace(/\.json$/,'.release.json'),intentValue={schema:1,token,id,hash,leaseId:lease.id};
  function retry(){clearTimeout(timer);timer=setTimeout(()=>{try{release();}catch{resume(base);}},Math.min(30000,250*2**Math.min(retries++,7)));timer.unref();}
  function release(){
   if(released)return {released:true};
   try{locked(base,()=>{if(released)return;const box=JSON.parse(regular.read(record));if(box.token!==token||box.id!==id||box.hash!==hash||box.leaseId!==lease.id)throw Error('报告保护身份已变化，原记录保留');
    if(fs.existsSync(intent)){const value=JSON.parse(regular.read(intent));if(JSON.stringify(value)!==JSON.stringify(intentValue))throw Error('报告释放凭据已变化，原记录保留');}
    lease.release();fs.unlinkSync(record);if(fs.existsSync(intent))fs.unlinkSync(intent);released=true;clearTimeout(timer);
   });resume(base);return {released:true};}
   catch(error){if(error.code!=='DATA_LOCK_BUSY')throw error;
    // Append an exact immutable cancellation intent without taking somebody
    // else's lease. If this CLI exits, the next holder can reclaim its dead
    // process lease and finish maintenance from the already durable request.
    try{fs.writeFileSync(intent,JSON.stringify(intentValue),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const value=JSON.parse(regular.read(intent));if(JSON.stringify(value)!==JSON.stringify(intentValue))throw Error('报告释放凭据已变化，原记录保留');}
    retry();resume(base);return {released:false,deferred:true};
   }
  }
  function expire(){if(released)return;if(!expired){expired=true;onExpire();}try{release();}catch{resume(base);}}
  timer=setTimeout(expire,Math.max(1,ttlMs));timer.unref();
  return {token,id,hash,expires,release};
 });
}
module.exports={locked,pins,pin,root,resume};
