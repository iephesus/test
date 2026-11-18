'use strict';
const {clean}=require('../lib/diagnostic-text');
// Only explicit add/retry requests may query a profile. Browsing is local-only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readerRoot}=require('../lib/data-layout'),{atomic}=require('../lib/update-progress'),{storagePaths,indexRead,mappedFolder}=require('../lib/storage'),{imageType}=require('../lib/image-cache');
const regular=require('../lib/regular-file'),MAX_SOURCE_BYTES=32*1024*1024,MAX_PROFILE_BYTES=1024*1024,MAX_AVATAR_BYTES=2*1024*1024;
function read(file,fallback=null){try{return JSON.parse(regular.read(file,{maxBytes:MAX_PROFILE_BYTES}).toString('utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
function sourceError(file,cause){return Object.assign(Error('本地头像资料来源无法安全读取：'+path.basename(file)+'；原文件保留，未发起资料查询',{cause}),{code:'LOCAL_PROFILE_SOURCE_INVALID'});}
function cancelled(signal){signal?.throwIfAborted();}
function untilCancelled(promise,signal){if(!signal)return Promise.resolve(promise);cancelled(signal);return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);},finish=callback=>value=>{signal.removeEventListener('abort',abort);callback(value);};signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(finish(resolve),finish(reject));});}

function folder(base,uid){if(!/^\d{5,20}$/.test(uid))throw Error('用户 UID 无效');return path.join(readerRoot(base),'profiles',uid);}
const {imageURL}=require('../lib/profile-image');
function identity(raw,uid){const values=[raw?.idstr,raw?.uid,raw?.id].filter(v=>v!=null),exact=values.filter(v=>typeof v==='string'||typeof v==='number'&&Number.isSafeInteger(v));if(!exact.length||exact.some(v=>String(v)!==uid))return null;const nickname=String(raw.screen_name||raw.name||'').trim();if(!nickname)return null;return {uid,nickname:nickname.slice(0,100),avatarURL:imageURL(raw.avatar_large||raw.avatar_hd||raw.profile_image_url||'')};}
function cached(base,uid,{avatar=true}={}){const dir=folder(base,uid);let box;try{box=read(path.join(dir,'identity.json'),{uid,status:'idle'});}catch{return {uid,status:'error',localSourceError:true,errorCode:'LOCAL_PROFILE_SOURCE_INVALID',message:'本地身份资料无法安全读取，原文件已保留；未发起资料查询'};}if(!box||Array.isArray(box)||box.uid!==uid)return {uid,status:'error',localSourceError:true,errorCode:'LOCAL_PROFILE_SOURCE_INVALID',message:'本地身份资料与 UID 不匹配，原文件已保留；未发起资料查询'};if(box.status==='loading'&&box.ownerPid&&box.ownerPid!==process.pid){try{process.kill(box.ownerPid,0);}catch{box.status=box.avatarStatus==='loading'&&box.remoteSucceededAt?'ready':'error';if(box.status==='ready')box.avatarStatus='error';box.message=box.remoteSucceededAt?'昵称已保存，头像加载中断，可重试头像':box.remoteAttemptAt?'上次资料识别中断，未确认请求可能已计费，可主动重试':'资料识别中断，可主动重试';}}let avatarData='';if(avatar&&/^[a-f0-9]{64}\.(?:jpg|png|gif|webp|avif)$/.test(box.avatarFile||'')){const file=path.join(dir,box.avatarFile);try{const s=fs.lstatSync(file);if(s.isFile()&&!s.isSymbolicLink()&&s.size<=MAX_AVATAR_BYTES){const views=require('../lib/file-view-cache'),before=views.stamp(file);avatarData=views.memo('profile-avatar\0'+file,before.signature,()=>{const bytes=regular.read(file,{maxBytes:MAX_AVATAR_BYTES}),type=imageType(bytes);if(views.stamp(file)?.signature!==before.signature)return '';return type&&crypto.createHash('sha256').update(bytes).digest('hex')===box.avatarFile.split('.')[0]?'data:image/'+(type==='jpg'?'jpeg':type)+';base64,'+bytes.toString('base64'):'';});}}catch{}}
 return {...box,avatarData};}
// Dismissal is local presentation state, scoped to one exact notice. Receipts and fees stay intact.
function noticeId(p){return crypto.createHash('sha256').update(JSON.stringify([p.status,p.message||'',p.noticeId||'',p.remoteAttemptAt||'',p.updatedAt||'',p.billing||null])).digest('hex');}
function summary(p){if(p.status==='error'){const text=require('../lib/terminal-report').conciseError(p.message);if(/IP_GEO_DENIED/.test(text))return '资料识别失败：当前网络所在地区不受服务支持。已有资料仍可使用。';return '资料识别失败：'+text;}return p.message||'';}
function view(base,uid,options){const p=cached(base,uid,options),id=noticeId(p);return {uid,nickname:p.nickname||'',avatarData:p.avatarData,avatarPending:options?.avatar===false&&!!p.avatarFile,profileStatus:p.status,code:p.status==='error'?require('../lib/diagnostic-codes').safe(p.errorCode):'NONE',profileAvatarStatus:p.avatarStatus||'',profileMessage:summary(p),profileDetails:p.status==='error'?p.message||'':p.avatarAttempt?.error?.message||'',profileBilling:p.billing||null,profileNoticeId:id,profileNoticeDismissed:p.dismissedNotice===id};}
function users(raw){if(raw?.result)return users(raw.result);if(raw?.response)return users(raw.response);for(const v of [raw?.users,raw?.data?.users,raw?.data,raw])if(Array.isArray(v))return v;if(raw?.user)return [raw.user];if(raw?.data?.user)return [raw.data.user];return raw?.screen_name?[raw]:[];}
async function local(base,uid,{signal}={}){
 cancelled(signal);const paths=storagePaths(base);let name='';for(const root of [paths.users,paths.posts])name ||=indexRead(root)[uid]?.nickname||'';let found=name?{uid,nickname:name,avatarURL:''}:null;const roots=[mappedFolder(paths.users,uid,indexRead(paths.users)),mappedFolder(paths.posts,uid,indexRead(paths.posts))];
 function walk(value,depth=0){cancelled(signal);if(!value||typeof value!=='object'||depth>10)return;const hit=identity(value,uid);if(hit){found={...found,...hit,avatarURL:hit.avatarURL||found?.avatarURL||''};if(found.avatarURL)return;}for(const v of Object.values(value)){if(found?.avatarURL)break;if(v&&typeof v==='object')walk(v,depth+1);}}
 function list(dir,pattern){try{const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('非普通目录');return regular.list(dir,pattern);}catch(error){if(error.code==='ENOENT')return [];throw sourceError(dir,error);}}
 for(const dir of roots){
  cancelled(signal);const cache=path.join(dir,'cache'),files=[...list(cache,/^(?!.*(?:updates|runs)).*\.json$/),...list(path.join(cache,'request-journal'),/\.response\.json$/)];
  for(const file of files.reverse()){
   await new Promise(resolve=>setImmediate(resolve));cancelled(signal);
   try{const views=require('../lib/file-view-cache'),before=views.regularStamp(file),bytes=regular.read(file,{maxBytes:MAX_SOURCE_BYTES}),value=JSON.parse(bytes.toString('utf8'));if(!before||views.regularStamp(file)?.signature!==before.signature)throw Error('来源在读取期间变化');walk(value);}catch(error){if(signal?.aborted)throw error;throw sourceError(file,error);}
   if(found?.avatarURL)break;
  }
  if(found?.avatarURL)break;
 }
 cancelled(signal);return found;
}
const jsonQuery=require('./json-query'),profileQueryOptions={timeoutMs:20000,maxBytes:8*1024*1024,timeoutCode:'PROFILE_QUERY_TIMEOUT',tooLargeCode:'PROFILE_QUERY_TOO_LARGE',messages:{cancelled:'用户资料查询已停止',timeout:'用户资料查询超时，未确认结果',tooLarge:'用户资料响应过大，未确认完整结果',failed:'用户资料查询失败',invalid:'用户资料响应格式无效'}};
const download=require('../lib/profile-image').download;
function createProfiles(base,{cli,publish=()=>{},run=(args,signal)=>jsonQuery.invoke(cli,args,signal,profileQueryOptions),downloadAvatar=download,lookupLocal=local}={}){
 const inflight=new Map(),epochs=new Map();let closed=false;
 function save(uid,value,epoch){if(closed||epochs.get(uid)!==epoch)return false;const stored={...value,uid};delete stored.avatarData;atomic(path.join(folder(base,uid),'identity.json'),stored);publish('userProfile',view(base,uid));return true;}
 function ensure(uid,{retry=false,refresh=false,avatarOnly=null,validateAuthor}={}){folder(base,uid);if(closed)return Promise.resolve();if(inflight.has(uid))return inflight.get(uid).promise;const old=cached(base,uid);if(old.localSourceError){publish('userProfile',view(base,uid));return Promise.resolve(old);}if(!retry&&!refresh&&old.remoteAttemptAt){publish('userProfile',view(base,uid));return Promise.resolve(old);}const epoch=(epochs.get(uid)||0)+1;epochs.set(uid,epoch);const controller=new AbortController();let attempted=false,receipt=null,billing=old.billing||null;
  const promise=(async()=>{let value={...old,noticeId:crypto.randomUUID(),ownerPid:process.pid,status:'loading',message:'正在识别昵称与头像…'};save(uid,value,epoch);try{
   // A retry of a failed image uses the last verified profile URL. Historical
   // comment snapshots must never replace fresh remote identity metadata.
   const hit=avatarOnly||(!refresh&&!old.remoteSucceededAt?await untilCancelled(lookupLocal(base,uid,{signal:controller.signal}),controller.signal):null);controller.signal.throwIfAborted();if(hit){if(hit.uid!==uid)throw Error('本地用户资料 UID 不匹配，未发起资料查询');value={...value,...hit};}const needsLookup=!avatarOnly&&(refresh||retry&&old.status==='error'||!(value.nickname&&value.avatarURL)&&(!old.remoteSucceededAt||retry&&!old.avatarURL));
   if(needsLookup){const details=await run(['commands','show','users','show_batch/other','--output','json'],controller.signal),c=details.command||details,p=require('../lib/command-pricing').parse(details,{group:'users',action:'show_batch/other'}),price=p?.unitPrice,flags=new Set((c.flags||[]).map(f=>f.name));if(!flags.has('uids')||!p)throw Error('资料接口的能力或价格尚未确认，未发起资料查询。可稍后重试');
    validateAuthor?.();
    billing={status:'estimated',unitPrice:price,priceType:c.price_type,estimatedCredits:price,actualCredits:null};value={...value,billing,message:'正在查询用户资料（单次估算 '+price+' credits，以实际计费为准）'};save(uid,value,epoch);controller.signal.throwIfAborted();receipt=path.join(folder(base,uid),'lookup-'+crypto.randomUUID()+'.json');const query={endpoint:'users show_batch/other',uids:uid};attempted=true;value.remoteAttemptAt=new Date().toISOString();save(uid,value,epoch);inflight.get(uid).requestPath=receipt;atomic(receipt,{schema:1,query,status:'inflight',startedAt:value.remoteAttemptAt});
    const raw=await run(['users','show_batch/other','--uids',uid,'--output','json'],controller.signal);const rows=users(raw);billing={...billing,status:raw.outcome||raw.billing?.status==='pending'||rows.length!==1?'unknown':'estimated',estimatedCredits:price*(c.price_type==='per_call'?1:rows.length)};if(fs.existsSync(receipt))atomic(receipt,{schema:1,query,status:'saved',response:raw,responseHash:crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex'),billing,savedAt:new Date().toISOString()});controller.signal.throwIfAborted();if(rows.length!==1)throw Error('资料接口未返回单个用户，原响应已保存，费用以服务端为准');const profile=rows.map(u=>identity(u,uid)).find(Boolean);if(!profile)throw Error('返回的用户资料 UID 不匹配，未更新身份信息');value={...value,...profile,remoteSucceededAt:new Date().toISOString(),billing,message:'昵称已识别，正在加载头像…'};save(uid,value,epoch);
   }
   validateAuthor?.();
   if(value.avatarURL&&old.avatarAttempt?.retryAt&&Date.parse(old.avatarAttempt.retryAt)>Date.now()&&old.avatarAttempt.urlHash===crypto.createHash('sha256').update(value.avatarURL).digest('hex')){value.avatarStatus='error';value.avatarAttempt=old.avatarAttempt;}else if(value.avatarURL&&(!value.avatarData||refresh||retry&&old.avatarStatus==='error')){
    const attempt={schema:1,id:crypto.randomUUID(),uid,urlHash:crypto.createHash('sha256').update(value.avatarURL).digest('hex'),status:'loading',startedAt:new Date().toISOString(),previousAvatarFile:old.avatarFile||null},attemptFile=path.join(folder(base,uid),'avatar-'+attempt.id+'.json');
    value.avatarStatus='loading';value.avatarAttempt=attempt;atomic(attemptFile,attempt);save(uid,value,epoch);
    try{
     const bytes=await downloadAvatar(value.avatarURL,controller.signal,event=>{controller.signal.throwIfAborted();if(epochs.get(uid)!==epoch)throw Object.assign(Error('头像任务已变化'),{code:'USER_CANCELLED'});attempt.transfers??=[];attempt.transfers.push({...event,at:new Date().toISOString()});atomic(attemptFile,attempt);value.avatarAttempt=attempt;value.message=event.status==='retry-wait'?'头像连接暂时失败，即将重试图片；不会重新查询付费资料':'昵称已识别，正在加载头像（第 '+event.attempt+' 次）…';save(uid,value,epoch);});if(bytes.length>MAX_AVATAR_BYTES)throw Object.assign(Error('头像文件过大'),{code:'AVATAR_TOO_LARGE'});const ext=imageType(bytes);if(!ext)throw Object.assign(Error('头像图片无效'),{code:'AVATAR_FORMAT'});controller.signal.throwIfAborted();if(epochs.get(uid)!==epoch)return;validateAuthor?.();
     const name=crypto.createHash('sha256').update(bytes).digest('hex')+'.'+ext,temp=path.join(folder(base,uid),name+'.'+crypto.randomUUID()+'.tmp');fs.mkdirSync(folder(base,uid),{recursive:true});let fd;try{fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,bytes);require('../lib/fs-sync').file(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,path.join(folder(base,uid),name));}finally{if(fd!=null)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
     value.avatarFile=name;value.avatarData='data:image/'+(ext==='jpg'?'jpeg':ext)+';base64,'+bytes.toString('base64');value.avatarStatus='ready';value.avatarAttempt={...attempt,status:'ready',avatarFile:name,finishedAt:new Date().toISOString()};
    }catch(e){
     if(controller.signal.aborted)throw e;
     const code=/^(?:AVATAR_(?:HTTP_[1-5]\d\d|TOO_LARGE|FORMAT|REDIRECT|URL|TIMEOUT|DNS|TLS|NETWORK)|EACCES|ENOSPC|EROFS|EIO)$/.test(e.code||'')?e.code:e.name==='TimeoutError'?'AVATAR_TIMEOUT':'AVATAR_DOWNLOAD_FAILED',message=code==='AVATAR_TIMEOUT'?'头像下载超时':code.startsWith('AVATAR_HTTP_')?'头像服务器返回 '+code.slice(12):code==='AVATAR_FORMAT'?'头像返回内容不是支持的图片':code==='AVATAR_TLS'?'头像服务器安全连接校验失败':code==='AVATAR_DNS'?'头像服务器地址解析失败':code==='AVATAR_URL'?'头像跳转地址不受支持':code==='AVATAR_NETWORK'?'头像网络连接失败':['EACCES','ENOSPC','EROFS','EIO'].includes(code)?'头像文件未能保存':'头像下载未完成';
     value.avatarStatus='error';value.avatarAttempt={...attempt,status:'error',finishedAt:new Date().toISOString(),error:{code,message,attempts:e.avatarAttempts||attempt.transfers?.filter(t=>t.status==='loading').length||1},...(e.retryAt?{retryAt:e.retryAt}:{})};
    }
    atomic(attemptFile,value.avatarAttempt);
   }else if(refresh&&!value.avatarURL){value.avatarStatus='unavailable';}
   const avatarFailed=value.avatarStatus==='error'||value.avatarStatus==='unavailable';
   value={...value,status:'ready',message:value.avatarStatus==='unavailable'?(value.avatarData?'资料未返回可用头像，暂用原头像；可重新查询资料':'昵称已识别，资料未返回可用头像；可重新查询资料'):avatarFailed?(value.avatarData?'昵称已更新，头像未更新，暂用原头像；'+(value.avatarAttempt?.error?.message||'下载未完成')+(value.avatarAttempt?.retryAt?'；服务器要求 '+new Date(value.avatarAttempt.retryAt).toLocaleString('zh-CN')+' 后重试':'，可重试头像'):'昵称已识别，头像未取得；'+(value.avatarAttempt?.error?.message||'下载未完成')+(value.avatarAttempt?.retryAt?'；服务器要求 '+new Date(value.avatarAttempt.retryAt).toLocaleString('zh-CN')+' 后重试':'，可重试头像')):value.avatarData?'昵称与头像已识别':'昵称已识别，暂未取得头像，可重试',billing,updatedAt:new Date().toISOString()};save(uid,value,epoch);return value;
  }catch(e){if(controller.signal.aborted||closed||epochs.get(uid)!==epoch)return;if(attempted&&receipt){const saved=read(receipt);if(saved?.status==='inflight'){billing={...billing,status:'unknown',actualCredits:null,estimatedCredits:null};atomic(receipt,{...saved,status:'unknown',billing});}}value={...value,status:'error',errorCode:require('../lib/diagnostic-codes').safe(e.code),message:clean(e.message),billing};save(uid,value,epoch);return value;}
  })().finally(()=>{if(inflight.get(uid)?.epoch===epoch)inflight.delete(uid);});inflight.set(uid,{epoch,promise,controller});return promise;
 }
 function ensurePostAuthor(postId,{expectedUid,allowPaidLookup=false}={}){
  if(closed)return Promise.resolve();
  const postWorkspace=require('./post-workspace'),author=postWorkspace.author(base,postId);
  if(!author)throw Object.assign(Error('这条博文没有可核验的外层发布者 UID'),{code:'POST_AUTHOR_UNKNOWN'});
  const {uid,dir,nickname}=author;
  const changed=()=>Object.assign(Error('博文发布者已变化，请重新打开博文确认'),{code:'POST_AUTHOR_CHANGED'});
  if(expectedUid!==uid)throw changed();
  const validateAuthor=()=>{if(postWorkspace.author(base,postId)?.uid!==uid)throw changed();};
  const old=cached(base,uid);
  if(old.localSourceError)throw Object.assign(Error(old.message),{code:old.errorCode});
  if(old.avatarData){publish('userProfile',view(base,uid));return Promise.resolve(old);}
  const avatarURL=imageURL(old.avatarURL)||require('../lib/legacy-web-evidence').readPostAvatar(dir,postId,uid)?.avatarURL;
  const options=avatarURL?{retry:true,avatarOnly:{uid,nickname:old.nickname||nickname,avatarURL}}:allowPaidLookup===true?{refresh:true}:null;
  if(!options)throw Object.assign(Error('本地没有这位发布者的头像地址，需要确认后查询用户资料'),{code:'POST_AUTHOR_AVATAR_PROOF_UNAVAILABLE'});
  return ensure(uid,{...options,validateAuthor}).then(result=>{validateAuthor();return result;});
 }
 function cancel(uid){
  const job=inflight.get(uid);if(!job)return;
  // Invalidate ownership before touching local evidence, even if a receipt is unreadable.
  epochs.set(uid,(epochs.get(uid)||0)+1);job.controller.abort();inflight.delete(uid);
  const old=cached(base,uid);if(old.localSourceError){publish('userProfile',view(base,uid));return;}
  const file=job.requestPath;let receipt,unreadable=false;try{receipt=file&&read(file);}catch{unreadable=true;}
  const unknown=unreadable||receipt?.status==='inflight';if(receipt?.status==='inflight')atomic(file,{...receipt,status:'unknown',billing:{...old.billing,status:'unknown',actualCredits:null,estimatedCredits:null}});
  const imageInterrupted=old.avatarStatus==='loading'&&old.remoteSucceededAt&&!unknown;
  const value={...old,status:imageInterrupted?'ready':'error',errorCode:unreadable?'REQUEST_EVIDENCE_INVALID':'USER_CANCELLED',message:imageInterrupted?'头像下载已停止，可重试头像':unreadable?'资料请求收据无法安全读取，原文件保留；资料识别已停止，费用结果未确认':unknown?'资料请求结果未确认，重试可能再次计费':'资料识别已停止，可以主动重试',...(unknown?{billing:{...old.billing,status:'unknown',actualCredits:null,estimatedCredits:null}}:{})};
  if(imageInterrupted){value.avatarStatus='error';value.avatarAttempt={...old.avatarAttempt,status:'error',finishedAt:new Date().toISOString(),error:{code:'AVATAR_INTERRUPTED',message:'头像下载已停止'}};if(/^[a-f0-9-]{36}$/.test(value.avatarAttempt.id||''))atomic(path.join(folder(base,uid),'avatar-'+value.avatarAttempt.id+'.json'),value.avatarAttempt);}
  delete value.avatarData;atomic(path.join(folder(base,uid),'identity.json'),value);
 }
 function dismiss(uid,id){const old=cached(base,uid);if(!old.localSourceError&&old.status!=='loading'&&id===noticeId(old)){const value={...old,dismissedNotice:id};delete value.avatarData;atomic(path.join(folder(base,uid),'identity.json'),value);}const result=view(base,uid);publish('userProfile',result);return result;}
 function close(){closed=true;for(const uid of inflight.keys())cancel(uid);}
 return {ensure,ensurePostAuthor,cancel,close,dismiss};
}
module.exports={folder,identity,cached,view,noticeId,local,users,imageURL,createProfiles};
