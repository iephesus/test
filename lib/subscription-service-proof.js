'use strict';
// Read-only service-condition proofs. Billing stays in the original ledger;
// retry intent stays in subscription settings and actual attempts in its rounds.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('./update-progress'),G=require('./gap-choice-proof'),J=require('./request-journal'),C=require('./core'),K=require('./subscription-key');
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(require('./regular-file').read(file,{maxBytes:16*1024*1024}));
function owner(round){return {uid:round.uid,targetKind:K.kind(round),source:round.source||'cli'};}
function queryMatches(round,q,query){return query?.uid===round.uid&&query.kind===q.kind&&query.count===q.count&&(query.maxId||'')===(q.maxId||'')&&(query.sinceId||'')===(q.sinceId||'')&&query.page===(q.page||1)&&uuid(query.taskId);}
function rejection(base,dir,round,q,{journal=J.proofReader(dir)}={}){
 if((round.source||'cli')!=='cli'||q.status!=='unknown')return null;
 require('./workspace-access').directory(base,path.relative(base,J.folder(dir)));
 const requests=journal.subscriptionRequests(round.id,q.id),found=[];
 for(const file of requests){
  const request=read(file);if(!request.rejection)continue;
  const ref=request.rejection,expected=path.basename(file).replace(/\.request\.json$/,'.rejection.json');
  if(!queryMatches(round,q,request.query)||request.billingReservation?.roundId!==round.id||request.billingReservation?.id!==q.id||ref.file!==expected||ref.code!=='IP_GEO_DENIED'||!/^[a-f0-9]{64}$/.test(ref.hash||''))throw Error('服务拒绝与原请求预留不匹配');
  const target=path.join(J.folder(dir),expected),bytes=require('./regular-file').read(target,{maxBytes:65536}),box=JSON.parse(bytes);
  if(hash(bytes)!==ref.hash||box.schema!==1||box.type!=='cli-service-rejection'||box.contentOutcome!=='service-rejected'||box.billing!=='unverified'||box.requestFile!==path.basename(file)||box.queryHash!==hash(JSON.stringify(box.query))||JSON.stringify(box.query)!==JSON.stringify(request.query)||box.billingReservation?.roundId!==round.id||box.billingReservation?.id!==q.id||!require('./service-rejection').safeCapture(box.capture)||!Number.isFinite(Date.parse(box.savedAt))||fs.existsSync(file.replace(/\.request\.json$/,'.response.json'))||fs.existsSync(file.replace(/\.request\.json$/,'.received.json')))throw Error('服务拒绝原始回执损坏或已有冲突正常响应，先保留并本地核对');
  found.push({kind:q.kind,code:'IP_GEO_DENIED',roundId:round.id,requestId:q.id,owner:owner(round),requestHash:G.digest(q),query:request.query,queryHash:box.queryHash,requestFile:path.relative(dir,file),requestFileHash:P.token(file),receipt:{file:path.relative(dir,target),hash:ref.hash},savedAt:box.savedAt});
 }
 if(found.length>1||found.length&&requests.length!==1)throw Error('服务拒绝包含多份冲突的原请求，未盲目重试');
 return found[0]||null;
}
function verify(base,dir,proof,{journal}={}){
 const B=require('./auto-follow-budget'),round=read(B.roundFile(base,proof.roundId)),q=round.requests?.find(v=>v.id===proof.requestId),value=q&&rejection(base,dir,round,q,{journal});
 if(!value||G.digest(value)!==G.digest(proof))throw Error('原服务拒绝或费用预留已变化，未继续请求');return value;
}
function roundManifest(base){return require('./file-view-cache').manifest(path.join(require('./auto-follow-budget').directory(base),'rounds'),{filter:/^[a-f0-9-]{36}\.json$/,strict:true});}
function attemptCandidates(uid,manifest){
 const views=require('./file-view-cache'),result=[];
 for(const {file}of manifest.files){
  const round=views.fileView(file,'subscription-service-attempt-v2',value=>({id:value.id,uid:value.uid,targetKind:K.kind(value),source:value.source||'cli',serviceRetry:value.serviceRetry,automaticRecovery:value.automaticRecovery,requests:(value.requests||[]).filter(q=>q.serviceRetryFor||q.automaticRecovery)}));
  if(round.uid!==uid||(round.source||'cli')!=='cli')continue;
  for(const q of round.requests)result.push({round,q});
 }
 return result;
}
function attempts(base,uid,kind,grantId){
 require('./auto-follow-budget').ledger(base); // Validate before using this discardable view.
 return attemptCandidates(uid,roundManifest(base)).filter(({q})=>q.kind===kind&&(!grantId||q.serviceRetryFor?.grantId===grantId));
}
function normalResponse(dir,round,q,{journal}={}){
 const initial=q.automaticRecovery?.initial===true&&q.sinceId==='',zero=q.kind==='post-comments'&&q.sinceId==='0';
 if(!['estimated','unknown'].includes(q.status)||!Number.isSafeInteger(q.returned)||q.returned<0||!q.file||!/^[a-f0-9]{64}$/.test(q.hash||'')||q.count!==1||(q.maxId||'')!==''||!(require('./completeness').exactId(q.sinceId)||initial||zero))return false;
 const file=require('../desktop/follow-response-evidence').verify(require('./exchange-store').baseFor(dir),dir,q),box=read(file),query=box.query;
 if(box.schema!==1||!queryMatches(round,q,query))return false;
 if(q.automaticRecovery&&query.taskId!==q.automaticRecovery.taskId)return false;
 const requests=journal?journal.subscriptionRequests(round.id,q.id):J.subscriptionRequests(dir,round.id,q.id);
 if(requests.length!==1)return false;
 if(![requests[0].replace(/\.request\.json$/,'.response.json'),requests[0].replace(/\.request\.json$/,'.received.json')].includes(path.resolve(file)))return false;
 const request=read(requests[0]);if(JSON.stringify(request.query)!==JSON.stringify(query)||request.billingReservation?.roundId!==round.id||request.billingReservation?.id!==q.id)return false;
 const recovered=journal?journal.recover(query):J.recover(dir,query);if(!recovered)return false;
 const raw=typeof box.responseText==='string'?JSON.parse(box.responseText):box.response;
 const replay=recovered.receivedResponse?JSON.parse(recovered.responseText):recovered.raw;
 if(G.digest(raw)!==G.digest(replay)||C.apiError(raw))return false;
 const rows=C.rawArray(raw,q.kind)?.items;
 if(q.kind==='post-comments')require('./post-comments').postPageRows(raw,round.uid);
 return !!rows&&rows.length===q.returned&&rows.length<=1&&rows.every(item=>{const row=C.normalize(item,q.kind,round.uid);return row.recordId&&(!q.sinceId||BigInt(row.recordId)>BigInt(q.sinceId))&&require('./record-body').completeBody(row,item)&&(q.kind!=='sent'||row.authorUid===round.uid);});
}
function restoredFrom(dir,proof,candidates,journal){
 for(const {round,q}of candidates){
  if(q.kind!==proof.kind)continue;
  if(q.automaticRecovery){
   const plan=round.automaticRecovery,ref=q.automaticRecovery;
   if(plan?.schema===1&&plan.policy==='continuous-cli-v1'&&plan.id===ref.planId&&plan.uid===proof.owner.uid&&plan.targetKind===proof.owner.targetKind&&plan.source==='cli'&&K.kind(round)===proof.owner.targetKind&&plan.kinds?.includes(proof.kind)&&(ref.windowId===round.id||ref.initial===true&&ref.windowId==='')&&ref.pendingToken===plan.pendingTokens?.[proof.kind]&&ref.proofToken===plan.proofTokens?.[proof.kind]&&Date.parse(q.at)>=Date.parse(proof.savedAt)&&normalResponse(dir,round,q,{journal}))return {roundId:round.id,requestId:q.id,file:q.file,hash:q.hash};
   continue;
  }
  const grant=round.serviceRetry,refs=q.serviceRetryFor;
  if(!grant||grant.schema!==1||!uuid(grant.id)||grant.id!==refs.grantId||grant.uid!==proof.owner.uid||grant.source!=='cli'||grant.targetKind!==proof.owner.targetKind||K.kind(round)!==proof.owner.targetKind||!grant.requests?.some(p=>G.digest(p)===G.digest(proof))||!refs.proofs?.some(p=>G.digest(p)===G.digest(proof))||!Number.isFinite(Date.parse(q.at))||Date.parse(q.at)<Date.parse(proof.savedAt))continue;
  if(normalResponse(dir,round,q,{journal}))return {roundId:round.id,requestId:q.id,file:q.file,hash:q.hash};
 }
 return null;
}
function restored(base,dir,proof){return restoredFrom(dir,proof,attempts(base,proof.owner.uid,proof.kind));}
function restorationReader(base,dir,entry,journal){
 let manifest,candidates;
 function prepare(proof){
  if((entry.source||'cli')!=='cli'||proof.owner.uid!==entry.uid||proof.owner.targetKind!==K.kind(entry)||proof.owner.source!=='cli')return false;
  if(!candidates){
   manifest=roundManifest(base);
   require('./auto-follow-budget').ledger(base);
   candidates=attemptCandidates(entry.uid,manifest).filter(({round})=>K.kind(round)===K.kind(entry));
  }
  return true;
 }
 return {
  restored(proof,{recheckRejection=false}={}){
   if(!prepare(proof))return null;
   if(recheckRejection)verify(base,dir,proof,{journal});
   return restoredFrom(dir,proof,candidates,journal);
  },
  // Only the candidate lookup is shared within this synchronous owner pass.
  // The caller rechecks the journal too and invalidates both on local replay.
  assertUnchanged(){if(manifest&&roundManifest(base).signature!==manifest.signature)throw require('./auto-follow-budget').safety('REQUEST_EVIDENCE_INVALID','服务恢复的原订阅账本在核对期间变化');},
  invalidate(){manifest=undefined;candidates=undefined;}
 };
}
function granted(base,dir,entry,proof){
 const grant=entry.serviceRetry;
 if(grant?.schema!==1||!uuid(grant.id)||grant.uid!==entry.uid||grant.targetKind!==K.kind(entry)||grant.source!=='cli'||(entry.source||'cli')!=='cli'||!Number.isFinite(Date.parse(grant.createdAt))||!Array.isArray(grant.requests)||grant.requests.length>128||!grant.requests.some(v=>G.digest(v)===G.digest(proof)))return null;
 verify(base,dir,proof);
 // Reservation, including an interrupted/unknown one, consumes the one attempt.
 if(attempts(base,entry.uid,proof.kind,grant.id).length)return null;
 return grant;
}
function grant(base,entry,dir){
 if((entry.source||'cli')!=='cli')return null;
 const kinds=entry.mode==='both'?['sent','received']:[entry.mode],requests=[],blocked=new Set();
 for(const file of require('./auto-follow-budget').ledger(base).pendingFiles(entry.uid,K.kind(entry),'cli')){
  const round=read(file);if(!K.matches(entry,round))throw Error('原服务拒绝不属于当前订阅对象');for(const q of round.requests||[])if(kinds.includes(q.kind)&&q.status==='unknown'){
   const proof=rejection(base,dir,round,q);if(proof&&!restored(base,dir,proof)){
    const pending=attempts(base,entry.uid,proof.kind).some(({round:attemptRound,q:attempt})=>attempt.serviceRetryFor?.proofs?.some(p=>G.digest(p)===G.digest(proof))&&!normalResponse(dir,attemptRound,attempt)&&!rejection(base,dir,attemptRound,attempt));
    if(pending)blocked.add(proof.kind);else requests.push(proof);
   }
  }
 }
 const available=requests.filter(p=>!blocked.has(p.kind));if(!available.length)return null;if(available.length>128)throw Error('服务拒绝数量超出本次安全恢复范围');
 return {schema:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),uid:entry.uid,targetKind:K.kind(entry),source:'cli',requests:available};
}
function allowQuery(base,dir,job,query){
 if(!job.serviceRetry||!queryMatches(job,{...query},query))return false;
 const records=require('./file-view-cache').manifest(J.folder(dir),{filter:/\.request\.json$/,strict:true}),matches=[];
 for(const {file}of records.files){const request=read(file);if(JSON.stringify(request.query)!==JSON.stringify(query)||!['inflight','unknown','received','saved'].includes(request.status)||fs.existsSync(file.replace(/\.request\.json$/,'.response.json'))||fs.existsSync(file.replace(/\.request\.json$/,'.received.json')))continue;
  const billing=request.billingReservation;if(!billing)return false;
  const B=require('./auto-follow-budget'),round=read(B.roundFile(base,billing.roundId)),q=round.requests?.find(v=>v.id===billing.id),proof=q&&rejection(base,dir,round,q);
  if(!proof||!granted(base,dir,job,proof))return false;matches.push(proof);
 }
 return matches.length>0;
}
module.exports={rejection,verify,normalResponse,restored,restorationReader,granted,grant,allowQuery};
