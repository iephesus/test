'use strict';
// A saved, identity-bound latest response can certify a future-check head even
// when older bodies are unavailable. It never certifies the older target range.
const fs=require('node:fs'),path=require('node:path');
const {rawArray,normalize,apiError}=require('./core');
const {exactId}=require('./completeness');
const {completeBody}=require('./record-body');
// The first visible page may be empty even though the service supplies a valid
// older cursor. Follow only a saved, same-task prefix; a lone later page never
// proves that its first comment is the latest visible one.
function initialSavedHead(dir,kind,uid,refs,taskId){
 if(!['sent','received'].includes(kind)||!Array.isArray(refs)||!refs.length||!/^[a-f0-9-]{36}$/.test(taskId||''))return null;
 let cursor='';const packets=[];
 for(const ref of refs){
  const {query,raw}=require('./request-journal').verifySavedResponse(dir,ref),parsed=rawArray(raw,kind);
  if(query.uid!==uid||query.kind!==kind||query.taskId!==taskId||query.page!==1||query.maxId!==cursor||query.sinceId!==''||query.count!==ref.count||ref.maxId!==cursor||ref.sinceId!==''||!parsed||apiError(raw)||parsed.items.length>query.count)return null;
  packets.push(ref);
  const ids=parsed.items.map(row=>exactId(row.idstr??row.id)),box=parsed.container,missing=box.miss_ids_str??box.miss_ids??[];
  if(!Array.isArray(missing)||missing.some(id=>!exactId(id)))return null;
  const count=Number(box.miss_count??missing.length);if(!Number.isSafeInteger(count)||count<0||count>new Set(missing.map(exactId)).size)return null;
  if(!ids.length){const next=require('./history').historyNext(raw,kind);if(missing.length||!exactId(next)||cursor&&BigInt(next)>=BigInt(cursor))return null;cursor=next;continue;}
  if(ids.some((id,i)=>!id||cursor&&BigInt(id)>BigInt(cursor)||i>0&&BigInt(id)>=BigInt(ids[i-1]))||missing.some(id=>BigInt(exactId(id))>=BigInt(ids[0])))return null;
  const row=normalize(parsed.items[0],kind,uid);if(!completeBody(row,parsed.items[0])||kind==='sent'&&row.authorUid!==uid)return null;
  return {id:ids[0],ref,packets,missingIds:missing.map(exactId)};
 }
 return null;
}
function candidate(dir,kind,uid,file){
 const j=JSON.parse(fs.readFileSync(file));
 if(j.schema!==1||j.uid!==uid||j.kind!==kind||j.checkpointToken!=='absent'||(j.anchor!==''&&!exactId(j.anchor))||!j.deltaComplete||j.phase!=='body'||!exactId(j.head)||!j.selectedIds?.includes(j.head)||j.scope?.from||j.scope?.to)return null;
 // Legacy journals encode the scope in the filename. Reject dated and foreign
 // task scopes instead of treating their newest saved point as a latest head.
 const recentScopes=['',...(j.ownerScopes||[]).filter(s=>typeof s==='string')];
 if(!recentScopes.some(taskScopeId=>path.basename(require('./data-update').progressFile(dir,kind,{beforeMs:null,taskScopeId}))===path.basename(file)))return null;
 const ref=j.packets?.[0];
 if(!ref?.envelope||ref.uid!==uid||ref.kind!==kind||ref.page!==1||ref.maxId!==''||ref.sinceId!==j.anchor||!Number.isSafeInteger(ref.count)||ref.count<1)return null;
 const packet=require('./incremental').restorePacket(ref,dir),envelope=JSON.parse(fs.readFileSync(packet.file));
 if(envelope.query.taskId!==j.id)return null;
 const parsed=rawArray(packet.raw,kind);if(!parsed||apiError(packet.raw)||parsed.items.length>ref.count)return null;
 if(!parsed.items.length){
  const head=initialSavedHead(dir,kind,uid,j.packets,j.id);if(head?.id!==j.head)return null;
  const checkedAt=envelope.savedAt||j.startedAt;if(!Number.isFinite(Date.parse(checkedAt)))return null;
  return {j,ref:head.ref,packets:head.packets,head:head.id,checkedAt,missingIds:head.missingIds,file};
 }
 const ids=parsed.items.map(item=>exactId(item.idstr??item.id));
 if(ids.some(id=>!id||(j.anchor&&BigInt(id)<=BigInt(j.anchor)))||ids[0]!==j.head||ids.some((id,i)=>i&&BigInt(id)>=BigInt(ids[i-1])))return null;
 const head=normalize(parsed.items[0],kind,uid);
 if(!completeBody(head,parsed.items[0])||kind==='sent'&&head.authorUid!==uid)return null;
 const box=parsed.container,missing=box.miss_ids_str??box.miss_ids??[];
 if(!Array.isArray(missing))return null;
 const missingIds=missing.map(exactId),count=Number(box.miss_count??missingIds.length);
 // Anonymous holes or a hole at/above the proposed head may hide a newer
 // record. Preserve the old stop in that case; never guess a maximum ID.
 if(missingIds.some(id=>!id||BigInt(id)>=BigInt(j.head))||!Number.isSafeInteger(count)||count<0||count>new Set(missingIds).size)return null;
 const checkedAt=envelope.savedAt||j.startedAt;
 if(!Number.isFinite(Date.parse(checkedAt)))return null;
 return {j,ref,head:j.head,checkedAt,missingIds,file};
}
function recoverInitialHead(dir,kind,uid){
 if(!['sent','received'].includes(kind))return null;
 const I=require('./incremental'),P=require('./update-progress'),target=I.stateFile(dir,kind);
 if(fs.existsSync(target))return I.readState(dir,kind,uid);
 const folder=path.join(dir,'cache/data-updates');if(!fs.existsSync(folder))return null;
 const candidates=[];
 for(const name of fs.readdirSync(folder).filter(n=>new RegExp('^'+kind+'_[a-f0-9]{16}\\.json$').test(n))){
  try{const c=candidate(dir,kind,uid,path.join(folder,name));if(c)candidates.push(c);}catch{continue;}
 }
 // Keep the earliest certified initial head. A later partial manual read may
 // coexist with an older unfinished range; it must not hide that new interval.
 candidates.sort((a,b)=>Date.parse(a.checkedAt)-Date.parse(b.checkedAt)||a.file.localeCompare(b.file));
 for(const c of candidates){
  if(unsettled(dir,c.j))continue;
  const proof={...c.ref};
  const value={schema:1,uid,kind,anchor:c.head,checkedAt:c.checkedAt,origin:'data-update-v1',endPolicyVersion:2,pending:null,baselineUnverified:false,visibleEnd:false,
   scope:{recentLimit:1,olderHistoryComplete:false},baselineScope:'verified-latest-head',proof:[proof],
   baselineRecovery:{journalFile:path.relative(dir,c.file),historyStatus:'unverified',missingIds:c.missingIds},
   connectedProof:{id:c.packets?c.j.id:c.j.id+'-head',initial:true,lower:null,upper:c.head,scopes:[],packets:c.packets||[proof]}};
  P.commit(target,'absent',value);
  return I.readState(dir,kind,uid);
 }
 return null;
}
function unsettled(dir,j){const folder=path.join(dir,'cache/request-journal');for(const file of require('./regular-file').list(folder,/^[a-f0-9-]+\.request\.json$/)){const q=JSON.parse(require('./regular-file').read(file));if(q.query?.taskId===j.id&&(!fs.existsSync(file.replace(/\.request\.json$/,'.response.json'))||!['saved'].includes(q.status)))return true;}return false;}
function observation(dir,kind,uid){initialEvidence(dir,kind,uid);const folder=path.join(dir,'cache/data-updates');if(!fs.existsSync(folder))return null;const found=[];for(const file of require('./regular-file').list(folder,new RegExp('^'+kind+'_[a-f0-9]{16}\\.json$'))){const c=candidate(dir,kind,uid,file);if(c)found.push(c);}found.sort((a,b)=>Date.parse(a.checkedAt)-Date.parse(b.checkedAt));return found[0]||null;}
function initialEvidence(dir,kind,uid){
 const folder=path.join(dir,'cache/data-updates');if(!fs.existsSync(folder))return;
 for(const name of fs.readdirSync(folder).filter(n=>new RegExp('^'+kind+'_[a-f0-9]{16}\\.json$').test(n))){
  try{const j=JSON.parse(require('./regular-file').read(path.join(folder,name)));if(j.schema!==1||j.uid!==uid||j.kind!==kind||!Array.isArray(j.packets))throw Error('原初始化任务身份或格式不一致');
   for(const ref of j.packets){const packet=require('./incremental').restorePacket(ref,dir),box=JSON.parse(require('./regular-file').read(packet.file)),q=box.query;
    if(q&&(q.uid!==uid||q.kind!==kind||q.page!==1||q.taskId!==j.id||q.count!==ref.count||q.maxId!==ref.maxId||(q.sinceId||'')!==(ref.sinceId||'')||ref.uid&&ref.uid!==uid||ref.kind&&ref.kind!==kind))throw Error('原初始化响应与对象或请求不一致');
    if(j.checkpointToken==='absent'&&j.deltaComplete&&j.phase==='body'&&ref===j.packets[0]&&q&&(!j.scope?.from&&!j.scope?.to)&&(q.sinceId!==(j.anchor||'')||rawArray(packet.raw,kind)?.items[0]&&exactId(rawArray(packet.raw,kind).items[0].idstr??rawArray(packet.raw,kind).items[0].id)!==j.head))throw Error('原初始化起点与响应不一致');
   }
  }catch(cause){throw Object.assign(Error('原初始化证据无法安全核实；保留原文件，未重新联网初始化'),{code:'REQUEST_EVIDENCE_INVALID',cause});}
 }
}
function initialize(opts,dir,kind,budget,flags,fetchPage){
 initialEvidence(dir,kind,opts.uid);
 const result=require('./data-update').harvestData({...opts,update:false,syncOperation:'regular',autoInitialBaseline:true,taskScopeId:opts.autoRoundId||opts.autoGuard.job.id,returnBudget:Math.min(opts.returnBudget??budget,budget)},dir,kind,budget,flags,fetchPage);let state=require('./incremental').readState(dir,kind,opts.uid);if(!state&&!result.cancelled&&!require('./auto-follow-budget').read(opts.autoGuard.file).requests.some(q=>q.kind===kind&&q.status!=='estimated'))state=recoverInitialHead(dir,kind,opts.uid);const ready=!!state?.checkedAt&&state.endPolicyVersion===2&&!state.pending;
 if(ready&&result.stopCode==='AUTO_BOUNDARY'){result.failed=false;result.stopCode=null;}
 result.update={initialized:true,caughtUp:ready,pending:!ready,newCount:result.newRows?.length||0,newRecordIds:(result.newRows||[]).map(r=>r.recordId)};
 result.reason=ready?'已用最新完整响应建立后续检查起点，并保存本轮额度内可见评论；既有正文和历史缺失保留':('最新响应尚未证明可用起点；保留订阅与历史证据，稍后安全重试；'+result.reason);
 if(!ready){result.failed=true;result.autoStop={code:'AUTO_BASELINE',message:result.reason};}return result;
}
module.exports={recoverInitialHead,initialize,observation,initialSavedHead};
