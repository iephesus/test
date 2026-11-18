'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic}=require('./update-progress');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function identity(query){return JSON.stringify([query.uid,query.kind,query.count,query.maxId,query.sinceId,query.page]);}
function continuationIdentity(query){return JSON.stringify([query.uid,query.kind,query.maxId,query.sinceId,query.page]);}
function folder(dir){return path.join(dir,'cache/request-journal');}
function invalid(file,cause){return Object.assign(Error('请求恢复证据无法读取，已停止后续请求；原文件保留：'+path.basename(file)),{code:'REQUEST_EVIDENCE_INVALID',cause});}
function requestSibling(file,suffix){if(typeof file!=='string'||!file.endsWith('.request.json'))throw invalid(String(file),Error('原请求文件名无效'));return file.replace(/\.request\.json$/,suffix);}
// Sync raw response evidence before publishing any dependent validation/progress.
function durable(file,value){const sync=require('./fs-sync');fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,JSON.stringify(value));sync.file(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);sync.directory(path.dirname(file));}finally{if(fd!=null)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
function journalManifest(dir,proof=false){const filter=proof?/\.(?:request|received|response|rejection)\.json$/:/\.(?:request|received|response)\.json$/;return require('./file-view-cache').manifest(folder(dir),{filter,strict:true});}
function index(dir,manifest=journalManifest(dir)){
 const root=folder(dir),view=require('./file-view-cache');
 return view.memo('request-journal-index-v4\0'+root,manifest.signature,()=>{
  const responses={},continuations={},received={},requests=[],subscriptions={},claims=Object.create(null),orphans=[];
  const files=new Set(manifest.files.map(({file})=>file));
  for(const {file}of manifest.files){
   try{
    const q=view.fileView(file,'request-journal-key-v4',box=>{
     if(box.schema!==1||!box.query||typeof box.query.taskId!=='string'||!box.query.taskId||typeof box.query.uid!=='string'||typeof box.query.kind!=='string')throw Error('请求身份或格式版本无效');
     if(file.endsWith('.request.json')&&!['inflight','unknown','received','saved','not-sent'].includes(box.status))throw Error('请求执行状态无效');
     if(box.status==='not-sent'&&(box.notSent?.schema!==1||box.notSent.guard!=='sdk-not-invoked-v1'||box.notSent.queryHash!==hash(JSON.stringify(box.query))||!Number.isFinite(Date.parse(box.notSent.at))))throw Error('未发送请求的本地证明无效');
     return {reservation:box.billingReservation,schema:box.schema,key:box.query.taskId+'\0'+identity(box.query),uid:box.query.uid,kind:box.query.kind,status:box.status,
      ...(file.endsWith('.response.json')&&box.query.maxId&&box.query.sinceId?{continuation:continuationIdentity(box.query)}:{})};
    });
    if(typeof q.reservation?.id==='string')(claims[q.reservation.id]??=[]).push(file);
    if(file.endsWith('.request.json')){
     requests.push({file,...q});if(q.reservation?.roundId&&q.reservation?.id)(subscriptions[q.reservation.roundId+':'+q.reservation.id]??=[]).push(file);
    }else{
     if(!files.has(file.replace(/\.(?:received|response|rejection)\.json$/,'.request.json')))orphans.push({file,uid:q.uid,kind:q.kind,roundId:q.reservation?.roundId});
     if(file.endsWith('.response.json')){
      (responses[q.key]??=[]).push(file);
      if(q.continuation)(continuations[q.continuation]??=[]).push(file);
     }else if(file.endsWith('.received.json'))(received[q.key]??=[]).push(file);
    }
   }catch(error){throw invalid(file,error);}
  }
  return {responses,continuations,received,requests,subscriptions,claims,orphans};
 });
}
function receivedEntry(dir,file,query,view){
 const root=folder(dir);
 if(!fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep))throw Error('响应路径越界');
 const entry=view.fileView(file,'journal-received',(box,meta)=>({raw:box,hash:meta.hash(),stamp:Date.parse(box.savedAt)})),box=entry.raw;
 if(box.schema!==1||box.query?.taskId!==query.taskId||identity(box.query)!==identity(query)||box.queryHash!==hash(JSON.stringify(box.query))||typeof box.responseText!=='string'||box.responseTextHash!==hash(box.responseText)||!Number.isFinite(entry.stamp))throw Error('已返回响应的身份、原文或哈希无效');
 const requestFile=file.replace(/\.received\.json$/,'.request.json'),request=view.readJSON(requestFile);
 if(request.schema!==1||request.query?.taskId!==query.taskId||identity(request.query)!==identity(query)||request.receivedFile&&request.receivedFile!==path.basename(file)||request.responseFile&&request.responseFile!==path.basename(file).replace(/\.received\.json$/,'.response.json')||request.receivedHash&&request.receivedHash!==entry.hash||JSON.stringify(request.billingReservation??null)!==JSON.stringify(box.billingReservation??null))throw Error('原请求与已返回响应的身份或哈希不匹配');
 return {...entry,requestFile};
}
function savedEntry(file,view){return view.fileView(file,'journal-response',(box,meta)=>({raw:box,hash:meta.hash(),stamp:Date.parse(box.savedAt)}));}
function responseEntry(dir,file,query,view,entry){
 const root=folder(dir);
 if(!fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep))throw Error('响应路径越界');
 entry??=savedEntry(file,view);const box=entry.raw;
 if(box.schema!==1||box.query?.taskId!==query.taskId||identity(box.query)!==identity(query)||!box.response||typeof box.response!=='object'||!Number.isFinite(entry.stamp))throw Error('响应身份、正文或保存时间无效');
 if(box.receivedFile||box.receivedHash){
  if(box.receivedFile!==path.basename(file).replace(/\.response\.json$/,'.received.json')||!/^[a-f0-9]{64}$/.test(box.receivedHash||''))throw Error('原始响应文本证据缺失或已变化');
  const received=receivedEntry(dir,path.join(root,box.receivedFile),query,view);
  if(received.hash!==box.receivedHash||box.savedAt!==received.raw.savedAt||!require('./exchange-schema').sameJSON(box.query,received.raw.query)||!require('./exchange-schema').sameJSON(box.response,JSON.parse(received.raw.responseText)))throw Error('正式响应与原始返回内容不一致');
 }
 return entry;
}
function verifySavedResponse(dir,ref){
 const name=ref?.file;if(typeof name!=='string'||!/^cache\/request-journal\/[a-f0-9-]{36}\.response\.json$/.test(name)||!/^[a-f0-9]{64}$/.test(ref.hash||''))throw invalid(String(name),Error('正式响应引用无效'));
 const file=path.join(dir,name),view=require('./file-view-cache');
 try{
  require('./workspace-access').directory(dir,'cache/request-journal');
  const entry=savedEntry(file,view),box=entry.raw,query=box.query;
  if(entry.hash!==ref.hash||!query?.taskId)throw Error('正式响应哈希或任务不匹配');
  responseEntry(dir,file,query,view,entry);
  const request=view.readJSON(file.replace(/\.response\.json$/,'.request.json'));
  if(request.schema!==1||request.status!=='saved'||request.responseFile!==path.basename(file)||request.savedAt!==box.savedAt||!require('./exchange-schema').sameJSON(request.query,query))throw Error('正式响应与原请求不一致');
  return {query:structuredClone(query),raw:structuredClone(box.response),billingReservation:structuredClone(request.billingReservation),received:box.receivedFile?{file:path.relative(dir,path.join(path.dirname(file),box.receivedFile)),hash:box.receivedHash}:null};
 }catch(error){throw invalid(file,error);}
}
function verifyContinuation(dir,ref,{uid,kind,maxId,sinceId}){
 const saved=verifySavedResponse(dir,ref),q=saved.query;
 if(!maxId||!sinceId||q.uid!==uid||q.kind!==kind||q.page!==1||q.maxId!==maxId||q.sinceId!==sinceId||
  ref.count!==q.count||!Number.isSafeInteger(q.count)||q.count<1||q.count>200)throw invalid(ref.file,Error('本地续页的身份、数量或上下界与当前核对不一致'));
 return saved;
}
function* savedContinuations(dir,scope){
 const view=require('./file-view-cache'),key=continuationIdentity({...scope,page:1});
 for(const file of index(dir).continuations[key]||[]){
  const entry=savedEntry(file,view),q=entry.raw.query;
  const ref={file:path.relative(dir,file),hash:entry.hash,stamp:entry.stamp,envelope:true,uid:q.uid,kind:q.kind,page:1,count:q.count,maxId:q.maxId,sinceId:q.sinceId,localReplay:true};
  const {raw}=verifyContinuation(dir,ref,scope);
  yield {raw,cached:true,cacheTimeMs:entry.stamp,receipt:ref};
 }
}
function recoverFromIndex(dir,query,lookup){
 if(!query.taskId)return null;
 const view=require('./file-view-cache'),key=query.taskId+'\0'+identity(query),records=lookup();
 for(const file of records.responses[key]||[]){
  try{
   const entry=responseEntry(dir,file,query,view),box=entry.raw;
   return {raw:structuredClone(box.response),cached:true,file,responseHash:entry.hash,recoveredRequest:true,cacheTimeMs:entry.stamp,receipt:{file:path.relative(dir,file),hash:entry.hash,envelope:true,uid:query.uid,kind:query.kind,page:query.page}};
  }catch(error){throw invalid(file,error);}
 }
 for(const file of records.received[key]||[]){
  try{
   const entry=receivedEntry(dir,file,query,view),box=entry.raw;
   const attempt={file:entry.requestFile,query:structuredClone(box.query),billingReservation:box.billingReservation,received:{file,hash:entry.hash,savedAt:box.savedAt}};
   return {responseText:box.responseText,cached:true,file,responseHash:entry.hash,recoveredRequest:true,receivedResponse:true,cacheTimeMs:entry.stamp,attempt};
  }catch(error){throw invalid(file,error);}
 }
 return null;
}
function recover(dir,query){return recoverFromIndex(dir,query,()=>index(dir));}
// A caller owns this locator for one synchronous proof pass. Every selected
// receipt still goes through the same raw identity and hash validation.
function proofReader(dir){
 const root=folder(dir),stamp=()=>require('./file-view-cache').stamp(root)?.signature;
 let records,directoryStamp,manifestSignature;
 function checkDirectory(){
  if(records&&stamp()!==directoryStamp)throw invalid(root,Error('请求目录在核对时变化'));
 }
 function assertUnchanged(){
  if(!records)return;
  checkDirectory();
  if(journalManifest(dir,true).signature!==manifestSignature)throw invalid(root,Error('原请求或响应在核对时变化'));
  checkDirectory();
 }
 function lookup(){
  if(!records){directoryStamp=stamp();const manifest=journalManifest(dir,true);manifestSignature=manifest.signature;records=index(dir,manifest);}
  checkDirectory();
  return records;
 }
 return {
  recover:query=>recoverFromIndex(dir,query,lookup),
  subscriptionRequests:(roundId,requestId)=>[...(lookup().subscriptions[roundId+':'+requestId]||[])],
  assertNoUnboundResponse(roundId,requestId,uid,kind){
   require('./workspace-access').directory(dir,'cache/request-journal');
   const {claims,orphans}=lookup(),file=claims[requestId]?.[0]||orphans.find(v=>v.roundId===roundId||v.uid===uid&&v.kind===kind)?.file;
   if(file)throw invalid(file,Error('原预留有未绑定的请求或响应'));
  },
  assertUnchanged,
  invalidate(){records=undefined;}
 };
}
function begin(dir,query,billingReservation){if(!query.taskId)return null;const file=path.join(folder(dir),crypto.randomUUID()+'.request.json');atomic(file,{schema:1,query,status:'inflight',startedAt:new Date().toISOString(),...(billingReservation?{billingReservation}:{})});return {file,query,billingReservation};}
function capture(file,query,responseText,cacheFile,billingReservation){
 const box={schema:1,query,queryHash:hash(JSON.stringify(query)),responseText,responseTextHash:hash(responseText),...(billingReservation?{billingReservation}:{}),cacheFile,savedAt:new Date().toISOString()};
 durable(file,box);return {file,hash:hash(require('./regular-file').read(file)),savedAt:box.savedAt};
}
function receiveStandalone(dir,query,responseText,cacheFile){
 return capture(path.join(dir,'cache/audit/cli-responses',crypto.randomUUID()+'.received.json'),query,responseText,cacheFile);
}
function receive(receipt,responseText,cacheFile){
 if(!receipt)return null;
 const file=requestSibling(receipt.file,'.received.json');
 const captured=capture(file,receipt.query,responseText,cacheFile,receipt.billingReservation);receipt.received=captured;
 atomic(receipt.file,{schema:1,query:receipt.query,status:'received',...(receipt.billingReservation?{billingReservation:receipt.billingReservation}:{}),receivedFile:path.basename(file),receivedHash:captured.hash,savedAt:captured.savedAt});return captured;
}
function rejectService(dir,query,attempt,capture){
 const safe=require('./service-rejection').safeCapture(capture);
 if(!safe||!query||Object.keys(query).some(k=>!['uid','kind','count','maxId','sinceId','page','taskId'].includes(k))||typeof query.uid!=='string'||!/^\d{5,20}$/.test(query.uid)||!['sent','received','both','mentions-comments','mentions-posts','post-comments'].includes(query.kind)||!Number.isSafeInteger(query.count)||query.count<1||!Number.isSafeInteger(query.page)||query.page<1||!['maxId','sinceId'].every(k=>typeof query[k]==='string'&&(!query[k]||/^[1-9]\d{4,19}$/.test(query[k])||k==='sinceId'&&query.kind==='post-comments'&&query[k]==='0'))||typeof query.taskId!=='string'||query.taskId&&!/^[a-f0-9-]{36}$/.test(query.taskId)||attempt&&JSON.stringify(attempt.query)!==JSON.stringify(query))throw Object.assign(Error('服务拒绝回执身份无法核实，未继续请求'),{code:'REQUEST_EVIDENCE_INVALID'});
 const billing=attempt?.billingReservation;if(billing&&(!/^[a-f0-9-]{36}$/.test(billing.id||'')||!/^[a-f0-9-]{36}$/.test(billing.roundId||'')))throw Object.assign(Error('服务拒绝回执预留身份无效'),{code:'REQUEST_EVIDENCE_INVALID'});
 const file=attempt?requestSibling(attempt.file,'.rejection.json'):path.join(dir,'cache/service-rejections',crypto.randomUUID()+'.json'),box={schema:1,type:'cli-service-rejection',query,queryHash:hash(JSON.stringify(query)),requestFile:attempt?path.basename(attempt.file):null,...(billing?{billingReservation:billing}:{}),capture:safe,contentOutcome:'service-rejected',billing:'unverified',savedAt:new Date().toISOString()};
 durable(file,box);const receipt={file:path.relative(dir,file),hash:hash(require('./regular-file').read(file))};
 if(attempt)attempt.rejection={file:path.basename(file),hash:receipt.hash,code:safe.code};
 return require('./service-rejection').description(receipt);
}
function save(receipt,raw,cacheFile){if(!receipt)return null;const file=requestSibling(receipt.file,'.response.json'),box={schema:1,query:receipt.query,response:raw,firstSavedIds:receipt.firstSavedIds||[],cacheFile,savedAt:receipt.received?.savedAt||new Date().toISOString(),...(receipt.received?{receivedFile:path.basename(receipt.received.file),receivedHash:receipt.received.hash}:{})};if(fs.existsSync(file)){if(!require('./regular-file').read(file).equals(Buffer.from(JSON.stringify(box))))throw invalid(file,Error('正式首次保存响应不可改写'));}else durable(file,box);atomic(receipt.file,{schema:1,query:receipt.query,status:'saved',...(receipt.billingReservation?{billingReservation:receipt.billingReservation}:{}),responseFile:path.basename(file),savedAt:box.savedAt});return {file,hash:hash(require('./regular-file').read(file)),envelope:true,uid:receipt.query.uid,kind:receipt.query.kind,page:receipt.query.page};}
function fail(receipt,error){if(receipt){const received=receipt.received;atomic(receipt.file,{schema:1,query:receipt.query,status:received?'received':'unknown',...(receipt.billingReservation?{billingReservation:receipt.billingReservation}:{}),...(received?{receivedFile:path.basename(received.file),receivedHash:received.hash,validationCode:require('./diagnostic-codes').safe(error?.code)}:{}),...(receipt.rejection?{rejection:receipt.rejection}:{}),failedAt:new Date().toISOString()});}}
function markNotSent(dir,attempt,code){
 if(!attempt||attempt.received||attempt.rejection)throw invalid(attempt?.file||'',Error('已接收或已调用请求不能标为未发送'));
 const file=attempt.file,box=JSON.parse(require('./regular-file').read(file,{maxBytes:65536}));
 if(path.dirname(path.resolve(file))!==path.resolve(folder(dir))||box.status!=='inflight'||JSON.stringify(box.query)!==JSON.stringify(attempt.query)||JSON.stringify(box.billingReservation??null)!==JSON.stringify(attempt.billingReservation??null)||['.received.json','.response.json','.rejection.json'].some(suffix=>fs.existsSync(requestSibling(file,suffix))))throw invalid(file,Error('原请求或已有响应不允许标为未发送'));
 const value={...box,status:'not-sent',notSent:{schema:1,guard:'sdk-not-invoked-v1',code:require('./diagnostic-codes').safe(code),queryHash:hash(JSON.stringify(box.query)),at:new Date().toISOString()}};
 durable(file,value);return {file:path.relative(dir,file),hash:hash(require('./regular-file').read(file)),queryHash:value.notSent.queryHash,billingReservation:box.billingReservation};
}
// A crash after capture may leave the original budget reservation pending.
// Reconcile only that exact saved request, using its saved price and raw count;
// never create a new reservation or touch a subscription/checkpoint.
function settleReceived(dir,attempt,raw){
 const billing=attempt?.billingReservation;if(!billing)return null;
 const fail=cause=>invalid(attempt.received.file,cause);
 try{
  if(!/^[a-f0-9-]{36}$/.test(billing.id||'')||!/^[a-f0-9-]{36}$/.test(billing.roundId||''))throw Error('原预算预留编号无效');
  const B=require('./auto-follow-budget'),base=require('./exchange-store').baseFor(dir),round=B.read(B.roundFile(base,billing.roundId)),query=attempt.query,q=round?.requests?.find(q=>q.id===billing.id);
  if(!round||round.id!==billing.roundId||round.uid!==query.uid||require('./subscription-key').kind(round)!==(query.kind==='post-comments'?'post':'user')||!q||q.kind!==query.kind||q.count!==query.count||(q.maxId||'')!==(query.maxId||'')||(q.sinceId||'')!==(query.sinceId||''))throw Error('原预算预留与已返回请求不匹配');
  if(Number.isSafeInteger(q.returned)&&q.file&&q.hash){
   if(q.returned!==require('./core').rawArray(raw,query.kind)?.items.length||q.hash!==attempt.received.hash||path.resolve(dir,q.file)!==path.resolve(attempt.received.file))throw Error('原结算与已返回证据不匹配');
   return {unverified:q.status==='unknown'};
  }
  if(!['reserved','unknown'].includes(q.status))throw Error('原预算预留状态无法核实');
  return B.createBudget(base,billing.roundId).settle(billing.id,{raw,file:path.relative(dir,attempt.received.file),responseHash:attempt.received.hash});
 }catch(error){if(error.code==='AUTO_RESPONSE_INVALID')throw error;throw fail(error);}
}
function unknown(dir,query){if(!query.taskId)return false;const key=query.taskId+'\0'+identity(query);return index(dir).requests.some(q=>q.key===key&&['inflight','unknown','received','saved'].includes(q.status)&&!fs.existsSync(q.file.replace(/\.request\.json$/,'.response.json'))&&!fs.existsSync(q.file.replace(/\.request\.json$/,'.received.json')));}
function subscriptionRequests(dir,roundId,requestId){return [...(index(dir).subscriptions[roundId+':'+requestId]||[])];}
module.exports={subscriptionRequests,folder,recover,verifySavedResponse,verifyContinuation,savedContinuations,proofReader,begin,receive,receiveStandalone,save,rejectService,fail,markNotSent,unknown,settleReceived};
