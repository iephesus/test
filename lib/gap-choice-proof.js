'use strict';
// Read-only proof checks shared by explicit gap choices and the dispatch guard.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('./update-progress'),I=require('./incremental');
// A later regular task can adopt an earlier task's exact response prefix.
// Its persisted journal binds that adoption; arbitrary foreign task IDs do not.
function adoptionProof(dir,kind,uid,state,index,snapshots){
 const p=state.pending,scopes=p.ownerScopes||[],seen=new Set();
 for(const scope of scopes){
  if(!/^[a-f0-9-]{36}$/.test(scope))continue;
  const file=require('./data-update').progressFile(dir,kind,{beforeMs:null,taskScopeId:scope});
  if(seen.has(file))continue;seen.add(file);
  if(snapshots?!snapshots.has(file):!fs.existsSync(file))continue;
  const bytes=snapshots?snapshots.get(file):require('./regular-file').read(file),j=JSON.parse(bytes),refs=j.deltaPackets?.length?j.deltaPackets:j.packets;
  if(j.schema!==1||j.id!==p.id||j.uid!==uid||j.kind!==kind||j.anchor!==state.anchor||j.head!==p.head||j.scope?.from||j.scope?.to||j.since!==p.since||!Array.isArray(j.ownerScopes)||!scopes.every(s=>j.ownerScopes.includes(s))||!Array.isArray(refs)||refs.length<=index)continue;
  const same=(a,b)=>a?.hash===b?.hash&&a.count===b.count&&a.maxId===b.maxId&&(a.sinceId||'')===(b.sinceId||'');
  if(!p.packets.slice(0,index+1).every((ref,i)=>same(ref,refs[i])))continue;
  return {file:path.relative(dir,file),hash:crypto.createHash('sha256').update(bytes).digest('hex'),taskId:j.id};
 }
 throw Error('复用响应缺少与当前任务绑定的原始进度证据，保留原检查位置');
}
function verifiedHead(dir,kind,uid,state,{snapshots}={}){
 const pending=state.pending,refs=pending?.packets;
 if(!refs?.length||refs[0].maxId!=='')throw Error('没有可核实的最新响应，保留原检查位置');
 const {rawArray,normalize,apiError}=require('./core'),{exactId}=require('./completeness');
 const since=pending.since?state.anchor:'',packets=[],missing=new Set(),seen=new Set();let cursor='',checkedAt=null,anonymous=0;const adoptions=[];
 // A latest-page probe may contain only missing IDs and a positive cursor.
 // Follow only its saved, hash-bound response chain to the leading full body;
 // an arbitrary older packet or archive maximum cannot establish this head.
 for(const ref of refs){
  if(ref.maxId!==cursor||seen.has(cursor)||!Number.isSafeInteger(ref.count)||ref.count<1||ref.count>200)throw Error('最新响应的分页连接无法核实，保留原检查位置');
  seen.add(cursor);
  const packet=I.restorePacket({...ref,sinceId:since},dir),box=JSON.parse(fs.readFileSync(packet.file)),q=box.query;
  if(box.schema!==1||q?.uid!==uid||q.kind!==kind||q.page!==1||q.maxId!==cursor||q.sinceId!==since||typeof q.taskId!=='string'||!/^[a-f0-9-]{36}$/.test(q.taskId))throw Error('最新响应身份或固定范围不匹配，保留原检查位置');
  if(q.taskId!==pending.id)adoptions.push({...adoptionProof(dir,kind,uid,state,packets.length,snapshots),responseHash:ref.hash,originalTaskId:q.taskId});
  const a=rawArray(packet.raw,kind);
  if(!a||apiError(packet.raw)||a.items.length>ref.count)throw Error('最新响应格式无法核实，保留原检查位置');
  if(!Number.isFinite(Date.parse(box.savedAt)))throw Error('最新响应缺少可核实的保存时间');
  checkedAt??=box.savedAt;packets.push({...ref,sinceId:since});
  const ids=a.items.map(r=>exactId(r.idstr??r.id));
  if(ids.some((id,i)=>!id||BigInt(id)<=BigInt(state.anchor)||cursor&&BigInt(id)>BigInt(cursor)||i&&BigInt(id)>=BigInt(ids[i-1])))throw Error('最新记录与已保存的起点证据不匹配');
  const values=a.container.miss_ids_str??a.container.miss_ids??[],count=Number(a.container.miss_count??values.length);
  if(!Array.isArray(values)||values.some(id=>!exactId(id)||BigInt(exactId(id))<=BigInt(state.anchor)||cursor&&BigInt(exactId(id))>BigInt(cursor))||!Number.isSafeInteger(count)||count<0)throw Error('最新响应的缺失边界无法核实，保留原检查位置');
  const pageMissing=new Set(values.map(exactId));for(const id of pageMissing)missing.add(id);anonymous=Math.max(anonymous,Math.max(0,count-pageMissing.size));
  if(ids.length){
   const head=normalize(a.items[0],kind,uid);
   if(ids[0]!==pending.head||!require('./record-body').completeBody(head,a.items[0])||kind==='sent'&&head.authorUid!==uid)throw Error('最新保存记录缺少可验证的独立正文，保留原检查位置');
   return {head:ids[0],checkedAt,ref:packets.at(-1),packets,adoptions,missingIds:[...missing],unidentifiedMissing:anonymous};
  }
  const step=require('./update-end').updateStep(packet.raw,kind,state.anchor,cursor,[]);
  if(step.connected||step.ambiguous||!step.next)break;
  cursor=step.next;
 }
 throw Error('已保存的最新响应尚无完整正文，暂不能更改后续检查起点；原数据和进度保留');
}
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
function digest(value){return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function read(file){return JSON.parse(require('./regular-file').read(file,{maxBytes:16*1024*1024}));}
function taskBinding(task){const value={...task};delete value.userGapChoice;return digest(value);}
function localDirectory(base,file){return require('./workspace-access').directory(base,path.relative(base,file));}
function dirFor(base,uid){const S=require('./storage'),p=S.storagePaths(base),dir=S.mappedFolder(p.users,uid,S.indexRead(p.users));localDirectory(base,dir);localDirectory(base,path.join(dir,'cache/updates'));return dir;}
function manualEvidence(base,{uid,kind,taskId,responseHash},expected=null,{frozen=false,journal}={}){
 if(typeof uid!=='string'||!/^\d{5,20}$/.test(uid)||!['sent','received'].includes(kind)||!uuid(taskId))throw Error('请选择原用户与评论方向的手动任务');
 const dir=dirFor(base,uid),tasks=path.join(require('./data-layout').readerRoot(base),'manual-tasks');localDirectory(base,tasks);
 const file=path.join(tasks,taskId+'.json'),taskBytes=frozen?Buffer.from(expected?.taskBytes||''):require('./regular-file').read(file,{maxBytes:1024*1024}),task=JSON.parse(taskBytes),q=task.query,scope=q?._scopeId;
 if(task.userGapChoice&&!expected)throw Error('该手动任务已用于明确选择，请使用新的已校验手动响应');
 if(task.schema!==1||task.id!==taskId||task.uid!==uid||!['complete','partial','failed','interrupted'].includes(task.status)||task.automatic||task.resumedBy||!q?.syncOnly||q.source&&q.source!=='cli'||require('../desktop/ui/form-utils').uid(q.target)!==uid||q.subject&&(q.subject.kind!=='user'||q.subject.uid!==uid)||task.target!=null&&require('../desktop/ui/form-utils').uid(task.target)!==uid||!['comments-'+kind,'comments-both'].includes(q.mode)||!uuid(scope)||q.from||q.to||q.before)throw Error('原手动任务不是该方向无日期的 CLI 读取，未选择后续起点');
 const journalFile=require('./data-update').progressFile(dir,kind,{beforeMs:null,taskScopeId:scope});localDirectory(base,path.dirname(journalFile));
 const journalBytes=frozen?Buffer.from(expected?.journalBytes||''):require('./regular-file').read(journalFile,{maxBytes:1024*1024});
 if(taskBytes.length+journalBytes.length>1024*1024)throw Error('手动任务证据过大，请选择一次较小的完整最新响应');
 const j=JSON.parse(journalBytes),refs=j.deltaPackets?.length?j.deltaPackets:j.packets;
 if(j.schema!==1||j.uid!==uid||j.kind!==kind||!uuid(j.id)||!j.ownerScopes?.includes(scope)||j.scope?.from||j.scope?.to||!Array.isArray(refs)||!refs.length||typeof j.anchor!=='string'||j.anchor&&!require('./completeness').exactId(j.anchor)||!require('./completeness').exactId(j.head))throw Error('原手动任务缺少固定范围与完整响应关联');
 const proof=verifiedHead(dir,kind,uid,{uid,kind,anchor:j.anchor,pending:{id:j.id,head:j.head,since:j.since,ownerScopes:j.ownerScopes,packets:refs}},{...(frozen?{snapshots:new Map([[journalFile,journalBytes]])}:{})});
 const ownJournal=!journal;journal??=require('./request-journal').proofReader(dir);
 for(const ref of proof.packets){const packet=I.restorePacket(ref,dir),box=read(packet.file),recovered=journal.recover(box.query);if(!recovered||recovered.receivedResponse||recovered.responseHash!==ref.hash||fs.realpathSync(recovered.file)!==fs.realpathSync(packet.file))throw Error('完整响应缺少可核实的原请求与原始收据');}
 if(ownJournal)journal.assertUnchanged();
 if(responseHash&&responseHash!==proof.ref.hash)throw Error('本次选择的完整响应已改变');
 const started=Date.parse(task.startedAt),finished=Date.parse(task.finishedAt),saved=Date.parse(proof.checkedAt);
 if(!Number.isFinite(started)||saved<started||Number.isFinite(finished)&&saved>finished)throw Error('响应时间不属于指定的手动任务，未使用旧缓存作为新起点');
 const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 const value={taskId,scope,source:'cli',taskBinding:taskBinding(task),taskHash:hash(taskBytes),taskBytes:taskBytes.toString('utf8'),journalFile:path.relative(dir,journalFile),journalHash:hash(journalBytes),journalBytes:journalBytes.toString('utf8'),proof};
 if(expected&&(value.taskBinding!==expected.taskBinding||frozen&&value.taskHash!==expected.taskHash||value.scope!==expected.scope||value.journalFile!==expected.journalFile||value.journalHash!==expected.journalHash||digest(value.proof)!==digest(expected.proof)))throw Error('手动任务或原始响应发生变化，请重新预览');
 return {dir,file,task,...value};
}
function roundIdentity(round){return {schema:round.schema,id:round.id,uid:round.uid,targetKind:require('./subscription-key').kind(round),source:round.source||'cli',subscriptionKey:round.subscriptionKey||null};}
function requestEvidence(dir,round,q,journal){
 const ownJournal=!journal;journal??=require('./request-journal').proofReader(dir);
 const files=[];
 for(const file of journal.subscriptionRequests(round.id,q.id)){
  const request=read(file),query=request.query;
  if(request.billingReservation?.roundId!==round.id||request.billingReservation?.id!==q.id||request.schema!==1||query?.uid!==round.uid||query.kind!==q.kind||query.count!==q.count||(query.maxId||'')!==(q.maxId||'')||(query.sinceId||'')!==(q.sinceId||'')||query.page!==(q.page||1)||!uuid(query.taskId))throw Error('原未知请求的身份或预留关联无法核实');
  if(request.rejection)throw Error('原请求已有明确服务拒绝，请先确认服务条件恢复；未把拒绝当作未知区间跳过');
  if(journal.recover(query))throw Error('原请求已有可恢复响应，请先完成本地核对，未跳过收据');
  files.push({file:path.relative(dir,file),hash:P.token(file)});
 }
 if(!files.length)journal.assertNoUnboundResponse(round.id,q.id,round.uid,q.kind);
 if(ownJournal)journal.assertUnchanged();
 return files.sort((a,b)=>a.file.localeCompare(b.file));
}
function pendingRequests(base,uid,kind,targetKind='user',{ledger}={}){
 const B=require('./auto-follow-budget'),values=[];
 localDirectory(base,path.join(B.directory(base),'rounds'));
 for(const file of (ledger||B.ledger(base)).pendingFiles(uid,targetKind,'cli')){
  const round=read(file);if(round.uid!==uid||require('./subscription-key').kind(round)!==targetKind||targetKind==='post'&&round.postId&&round.postId!==uid||(round.source||'cli')!=='cli')throw Error('原订阅账本身份已变化');
  for(const q of round.requests||[])if(q.kind===kind&&['reserved','unknown'].includes(q.status))values.push({roundId:round.id,requestId:q.id,identity:roundIdentity(round),request:q,roundHash:P.token(file),roundStatus:round.status});
 }
 return values.sort((a,b)=>(a.roundId+':'+a.requestId).localeCompare(b.roundId+':'+b.requestId));
}
// This token includes all pending requests of the direction, including returned
// billing-unknown rows. A new failure between inspection and wire changes it.
function pendingToken(base,uid,kind,targetKind='user',options){return digest(pendingRequests(base,uid,kind,targetKind,options).map(v=>({identity:v.identity,request:v.request})));}
function unknownSnapshot(base,dir,uid,kind,checkedAt){
 const items=pendingRequests(base,uid,kind),values=[];
 if(!items.length||items.length>128)throw Error('未确认请求数量为空或超出本次安全预览范围');
 for(const item of items){
  const q=item.request;
  if(item.roundStatus==='running'||!uuid(item.roundId)||!uuid(q.id)||q.status!=='unknown'||q.count!==1||(q.maxId||'')!==''||q.page!=null&&q.page!==1||q.sinceId&&!require('./completeness').exactId(q.sinceId)||q.file||q.hash||q.returned!=null||!Number.isFinite(Date.parse(q.at))||Date.parse(q.at)>Date.parse(checkedAt))throw Error('旧请求不是本次手动响应之前、无可恢复收据的单条未知检查，未放行');
  const requestFiles=requestEvidence(dir,{...item.identity},q);
  values.push({...item,requestHash:digest(q),requestFiles});
 }
 return values;
}
function sameUnknown(base,dir,uid,kind,snapshot,journal){
 const B=require('./auto-follow-budget'),round=read(B.roundFile(base,snapshot.roundId)),q=round.requests?.find(q=>q.id===snapshot.requestId);
 if(!q||round.status==='running'||round.uid!==uid||q.kind!==kind||digest(roundIdentity(round))!==digest(snapshot.identity)||digest(q)!==snapshot.requestHash||q.status!=='unknown'||digest(requestEvidence(dir,round,q,journal))!==digest(snapshot.requestFiles))throw Error('原未知请求或收据已变化，未沿用旧选择');
 return q;
}
function retainedHead(dir,kind,uid,state,{journal,supporting}={}){
 const ownJournal=!journal;journal??=require('./request-journal').proofReader(dir);
 if(state?.pending||!state?.checkedAt||state.uid!==uid||state.kind!==kind||state.endPolicyVersion!==2||state.baselineUnverified)throw Error('当前更高起点缺少可核实的完整连接，未授权回退或覆盖');
 const selected=state.userSelectedHead;
 if(state.baselineScope==='user-selected-latest-head'&&selected?.head===state.anchor){
  // An explicit skipped interval deliberately has no connecting proof for its
  // new head. Its older connection must not masquerade as one, nor block a
  // later, separately authorized future check that retains this exact head.
  if(!uuid(selected.decisionId))throw Error('原明确选择编号无效');
  const base=require('./exchange-store').baseFor(dir),choices=path.join(require('./data-layout').readerRoot(base),'gap-choices'),tasks=path.join(require('./data-layout').readerRoot(base),'manual-tasks');localDirectory(base,choices);localDirectory(base,tasks);
  if(!require('./subscription-boundary').trustedHead(dir,kind,uid,state))throw Error('原明确选择的起点原文无法核实');
  const file=path.join(choices,selected.decisionId+'.json'),bytes=require('./regular-file').read(file,{maxBytes:16*1024*1024}),decision=JSON.parse(bytes),step=decision.steps?.find(s=>s.kind===kind);
  if(decision.schema!==1||decision.status!=='committed'||decision.id!==selected.decisionId||decision.uid!==uid||!uuid(decision.taskId)||!uuid(decision.scope)||!state.userGapChoices?.includes(decision.id)||selected.historyStatus!=='user-skipped-unverified'||selected.at!==decision.at||step?.value?.uid!==uid||step.value.kind!==kind||step.value.anchor!==state.anchor||step.value.userSelectedHead?.decisionId!==decision.id||step.proof?.hash!==selected.proof?.hash)throw Error('原明确选择的后续起点无法核实');
  let proof;
  if(decision.mode==='future-from-manual'){
   if(decision.source!=='cli'||decision.targetKind!=='user'||decision.kind!==kind||decision.baselineAction!=='select-manual-head'||decision.authorizationHash!==futureAuthorization(decision)||state.userUnknownChoiceHashes?.[decision.id]!==decision.authorizationHash)throw Error('原后续起点授权无法核实');
   proof=manualEvidence(base,{uid,kind,taskId:decision.taskId,responseHash:selected.proof.hash},decision.manual,{frozen:true,journal}).proof;
  }else{
   const taskFile=path.join(tasks,decision.taskId+'.json');
   const taskBytes=require('./regular-file').read(taskFile,{maxBytes:16*1024*1024}),task=JSON.parse(taskBytes),query=task.query;
   if(decision.mode!=null||decision.source!=null&&decision.source!=='cli'||decision.reason!=='user-ignored-middle-interval'||task.schema!==1||task.id!==decision.taskId||task.uid!==uid||task.automatic||!['complete','partial','failed','interrupted'].includes(task.status)||task.userGapChoice?.id!==decision.id||query?._scopeId!==decision.scope||!query.syncOnly||query.source&&query.source!=='cli'||require('../desktop/ui/form-utils').uid(query.target)!==uid||query.subject&&(query.subject.kind!=='user'||query.subject.uid!==uid)||!['comments-'+kind,'comments-both'].includes(query.mode)||query.from||query.to||query.before||step.previous?.uid!==uid||step.previous.kind!==kind||!step.previous.pending?.ownerScopes?.includes(decision.scope))throw Error('原忽略区间的任务与明确选择不匹配');
   proof=verifiedHead(dir,kind,uid,step.previous);
   // This legacy branch reads live task and adopted progress files. Keep
   // their exact bytes in the final check without changing stored proof data.
   if(supporting){
    supporting.push({file:taskFile,hash:crypto.createHash('sha256').update(taskBytes).digest('hex')});
    for(const adoption of proof.adoptions)supporting.push({file:path.join(dir,adoption.file),hash:adoption.hash});
   }
  }
  if(proof.head!==state.anchor||proof.checkedAt!==step.value.checkedAt||!Number.isFinite(Date.parse(state.checkedAt))||Date.parse(state.checkedAt)<Date.parse(proof.checkedAt)||proof.ref.hash!==selected.proof.hash||digest(proof.packets)!==digest(selected.packets))throw Error('原选择的完整响应发生变化');
  for(const ref of proof.packets){const packet=I.restorePacket(ref,dir),box=read(packet.file),response=journal.recover(box.query);if(!response||response.receivedResponse||response.responseHash!==ref.hash||fs.realpathSync(response.file)!==fs.realpathSync(packet.file))throw Error('原选择起点的请求或原始收据无法核实');}
  if(ownJournal)journal.assertUnchanged();
  return {head:state.anchor,checkedAt:state.checkedAt,userSelectedHead:selected,decision:{id:decision.id,hash:crypto.createHash('sha256').update(bytes).digest('hex')},proof};
 }
 if(!state.connection||!require('./subscription-boundary').trustedHead(dir,kind,uid,state))throw Error('当前更高起点缺少可核实的完整连接，未授权回退或覆盖');
 const file=path.join(dir,'cache',state.connection.file),bytes=require('./regular-file').read(file,{maxBytes:16*1024*1024}),proof=JSON.parse(bytes);
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==state.connection.hash||proof.upper!==state.anchor||!Array.isArray(proof.packets)||!proof.packets.length)throw Error('当前更高起点的连接证据已变化');
 for(const ref of proof.packets){const packet=I.restorePacket(ref,dir),box=read(packet.file),restored=journal.recover(box.query);if(!restored||restored.receivedResponse||restored.responseHash!==ref.hash||fs.realpathSync(restored.file)!==fs.realpathSync(packet.file))throw Error('当前更高起点的原始请求或完整响应无法核实');}
 if(ownJournal)journal.assertUnchanged();
 return {head:state.anchor,checkedAt:state.checkedAt,connection:state.connection,proof};
}
function futureAuthorization(decision){return digest(Object.fromEntries(['schema','id','mode','source','targetKind','workspace','uid','kind','taskId','scope','manual','unknowns','pendingToken','at','reason','expectedCheckpoint','originalStateHash','authorization','baselineAction','authorizedLower','retainedHeadProof'].map(key=>[key,decision[key]])));}
function futureAuthority(base,dir,uid,kind,decisionId,state,journal){
 if(!state?.userUnknownChoices?.includes(decisionId)||!state.checkedAt||state.endPolicyVersion!==2)return null;
 if(path.resolve(dir)!==path.resolve(dirFor(base,uid)))throw Error('后续起点不属于原资料目录');
 const folder=path.join(require('./data-layout').readerRoot(base),'gap-choices');localDirectory(base,folder);
 const file=path.join(folder,decisionId+'.json'),bytes=require('./regular-file').read(file,{maxBytes:16*1024*1024}),decision=JSON.parse(bytes),step=decision.steps?.find(s=>s.kind===kind);
 if(decision.schema!==1||decision.mode!=='future-from-manual'||decision.status!=='committed'||decision.id!==decisionId||decision.workspace!==fs.realpathSync(base)||decision.uid!==uid||decision.kind!==kind||decision.source!=='cli'||decision.targetKind!=='user'||!['retain-current-head','select-manual-head'].includes(decision.baselineAction)||step?.value?.userUnknownChoiceHashes?.[decisionId]!==decision.authorizationHash||decision.authorizedLower!==decision.manual?.proof?.head||BigInt(step.value.anchor)<BigInt(decision.authorizedLower)||!Array.isArray(decision.unknowns)||!decision.unknowns.length||decision.unknowns.length>128||decision.authorizationHash!==futureAuthorization(decision)||state.userUnknownChoiceHashes?.[decisionId]!==decision.authorizationHash)throw Error('后续起点选择记录无法核实，原未知区间保留');
 const manual=manualEvidence(base,{uid,kind,taskId:decision.taskId,responseHash:decision.manual.proof.ref.hash},decision.manual,{frozen:true,journal}),head=manual.proof.head;
 const supporting=[];
 if(decision.retainedHeadProof){
  const retained=retainedHead(dir,kind,uid,decision.steps[0].previous,{journal,supporting});
  if(digest(retained)!==digest(decision.retainedHeadProof))throw Error('保留的更高起点证明发生变化');
  if(retained.decision)supporting.push({file:path.join(folder,retained.decision.id+'.json'),hash:retained.decision.hash});
  if(retained.connection)supporting.push({file:path.join(dir,'cache',retained.connection.file),hash:retained.connection.hash});
 }
 const minimum=step.value.anchor;
 if(!require('./completeness').exactId(state.anchor)||BigInt(state.anchor)<BigInt(minimum))throw Error('新请求低于用户明确选择的后续起点');
 const result={decisionId,choiceHash:crypto.createHash('sha256').update(bytes).digest('hex'),head,proof:manual.proof,at:decision.at};
 return {file,minimum,unknowns:decision.unknowns,result,supporting};
}
// Verify the common authority once per synchronous proof pass. Each lookup
// still revalidates its own original round, reservation and request evidence.
function futureChoiceReader(base,dir,uid,kind,{state,journal=require('./request-journal').proofReader(dir)}={}){
 let checkpointToken;
 const authorities=new Map(),checkpoint=I.stateFile(dir,kind);
 const token=file=>{
  try{return crypto.createHash('sha256').update(require('./regular-file').read(file,{maxBytes:16*1024*1024})).digest('hex');}
  catch(error){if(error.code==='ENOENT')return 'absent';throw error;}
 };
 function current(){
  if(checkpointToken===undefined){
   const before=token(checkpoint);
   const latest=I.readState(dir,kind,uid);
   if(token(checkpoint)!==before||state!=null&&digest(state)!==digest(latest))throw Error('后续起点的检查点在核对时变化');
   state=latest;checkpointToken=before;
  }
  return state;
 }
 function assertUnchanged(){
  if(checkpointToken!==undefined&&token(checkpoint)!==checkpointToken)throw Error('后续起点的检查点在核对时变化');
  for(const authority of authorities.values())if(authority){
   if(token(authority.file)!==authority.result.choiceHash||authority.supporting.some(value=>token(value.file)!==value.hash))throw Error('后续起点选择在核对时变化');
  }
 }
 function committed(decisionId,{requestId,roundId,sinceId}={}){
  if(!uuid(decisionId))return null;
  if(!authorities.has(decisionId))authorities.set(decisionId,futureAuthority(base,dir,uid,kind,decisionId,current(),journal));
  const authority=authorities.get(decisionId);if(!authority)return null;
  if(sinceId!=null&&(!require('./completeness').exactId(sinceId)||BigInt(sinceId)<BigInt(authority.minimum)))throw Error('新请求低于用户明确选择的后续起点');
  if(roundId||requestId){const snapshot=authority.unknowns.find(q=>q.roundId===roundId&&q.requestId===requestId);if(!snapshot)return null;sameUnknown(base,dir,uid,kind,snapshot,journal);}
  return authority.result;
 }
 function unknown(roundId,requestId){
  const ids=current()?.userUnknownChoices;
  if(!Array.isArray(ids)||ids.length>128)return null;
  for(const id of ids){const value=committed(id,{roundId,requestId});if(value)return value;}
  return null;
 }
 return {committed,unknown,assertUnchanged};
}
function committedFuture(base,dir,uid,kind,decisionId,{state,...request}={}){
 const journal=require('./request-journal').proofReader(dir),reader=futureChoiceReader(base,dir,uid,kind,{state,journal});
 const value=reader.committed(decisionId,request);reader.assertUnchanged();journal.assertUnchanged();return value;
}
function unknownChoice(base,dir,uid,kind,roundId,requestId){
 const journal=require('./request-journal').proofReader(dir),reader=futureChoiceReader(base,dir,uid,kind,{journal});
 const value=reader.unknown(roundId,requestId);reader.assertUnchanged();journal.assertUnchanged();return value;
}
function usedManual(base,dir,uid,kind,taskId,taskHash){const state=I.readState(dir,kind,uid);for(const id of state?.userUnknownChoices||[]){if(!uuid(id))throw Error('原选择记录编号无效');const d=read(path.join(require('./data-layout').readerRoot(base),'gap-choices',id+'.json'));if(d.status==='committed'&&d.uid===uid&&d.kind===kind&&d.taskId===taskId&&d.manual?.taskBinding===taskHash&&d.authorizationHash===futureAuthorization(d)&&state.userUnknownChoiceHashes?.[id]===d.authorizationHash)return true;}return false;}
module.exports={verifiedHead,digest,taskBinding,manualEvidence,pendingRequests,pendingToken,unknownSnapshot,sameUnknown,retainedHead,futureAuthorization,committedFuture,unknownChoice,futureChoiceReader,usedManual};
