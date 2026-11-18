'use strict';
// Avatar transport is independent of paid profile lookup. Two bounded attempts,
// unchanged TLS/host policy, no credential/header/route variants.
const {imageType}=require('./image-cache');
const MAX_BYTES=2*1024*1024;
function imageURL(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&/(^|\.)sinaimg\.(cn|com)$/i.test(u.hostname)?u.href:'';}catch{return '';}}
const error=(code,message)=>Object.assign(Error(message),{code});
function classify(e){if(e.name==='TimeoutError')return 'AVATAR_TIMEOUT';if(/^AVATAR_/.test(e.code||''))return e.code;const cause=e.cause?.code||e.code;return /(?:TLS|CERT|SSL)/.test(cause||'')?'AVATAR_TLS':/ENOTFOUND|EAI_AGAIN/.test(cause||'')?'AVATAR_DNS':'AVATAR_NETWORK';}
function transient(e){return e.name==='TimeoutError'||['ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','EAI_AGAIN'].includes(e.cause?.code||e.code)||['AVATAR_HTTP_408','AVATAR_HTTP_429','AVATAR_HTTP_502','AVATAR_HTTP_503','AVATAR_HTTP_504'].includes(e.code);}
function create({fetcher=(...args)=>globalThis.fetch(...args),sleep=(ms,signal)=>require('node:timers/promises').setTimeout(ms,undefined,{signal}),random=Math.random,timeout=10000,now=Date.now}={}){
 return async function download(url,signal,onAttempt=()=>{}){
  if(!imageURL(url))throw error('AVATAR_URL','头像地址不受支持');
  for(let attempt=1;attempt<=2;attempt++){
   signal?.throwIfAborted();const deadline=AbortSignal.timeout(timeout),combined=signal?AbortSignal.any([signal,deadline]):deadline;
   onAttempt({attempt,status:'loading'});
   try{
    let current=url;
    for(let redirects=0;redirects<4;redirects++){
     if(!imageURL(current))throw error('AVATAR_URL','头像跳转地址不受支持');
     const response=await fetcher(current,{redirect:'manual',signal:combined});
     if(response.status>=300&&response.status<400){await response.body?.cancel();const location=response.headers.get('location');if(!location)throw error('AVATAR_REDIRECT','头像跳转缺少地址');try{current=new URL(location,current).href;}catch{throw error('AVATAR_REDIRECT','头像跳转地址无效');}continue;}
     if(!response.ok){await response.body?.cancel();const failure=error('AVATAR_HTTP_'+response.status,'头像服务器返回 '+response.status),after=response.headers?.get('retry-after');if(after){const delay=/^\d+$/.test(after.trim())?Number(after.trim())*1000:Date.parse(after)-now();if(delay>=0){failure.retryAfterMs=delay;const at=now()+delay;if(Number.isSafeInteger(at)&&at<8640000000000000)failure.retryAt=new Date(at).toISOString();}}throw failure;}
     const length=response.headers.get('content-length');if(length&&/^\d+$/.test(length)&&Number(length)>MAX_BYTES){await response.body?.cancel();throw error('AVATAR_TOO_LARGE','头像文件过大');}
     const chunks=[];let size=0;try{for await(const chunk of response.body){combined.throwIfAborted();size+=chunk.length;if(size>MAX_BYTES)throw error('AVATAR_TOO_LARGE','头像文件过大');chunks.push(chunk);}}finally{if(!response.body?.locked)await response.body?.cancel().catch(()=>{});}
     combined.throwIfAborted();const bytes=Buffer.concat(chunks);if(!imageType(bytes))throw error('AVATAR_FORMAT','头像返回内容不是支持的图片');onAttempt({attempt,status:'ready'});return bytes;
    }
    throw error('AVATAR_REDIRECT','头像跳转次数过多');
   }catch(e){
    signal?.throwIfAborted();if(deadline.aborted)e=deadline.reason;const code=classify(e),delay=Math.max(Number(e.retryAfterMs)||0,1000+Math.round(Math.max(0,Math.min(1,random()))*500)),retry=attempt<2&&transient(e)&&delay<=5000;
    onAttempt({attempt,status:retry?'retry-wait':'error',code,...(retry?{retryAfterMs:delay}:{}),...(e.retryAt?{retryAt:e.retryAt}:{})});
    if(!retry)throw Object.assign(Error(e.message,{cause:e}),{code,name:e.name,avatarAttempts:attempt,...(e.retryAt?{retryAt:e.retryAt}:{})});
    await sleep(delay,signal);signal?.throwIfAborted();
   }
  }
 };
}
module.exports={create,download:create(),imageURL};
