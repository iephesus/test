'use strict';
// A known bad boundary may be rechecked; an unknown wire outcome may not.
// Recheck only the original bounded request, under the current original budget.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const I=()=>require('./incremental'),C=require('./core');
function trustedHead(dir,kind,uid,state){
 if(kind==='post-comments'&&require('./post-subscription').verifiedBaseline(dir,uid,state))return true;
 const selected=state.userSelectedHead;
 if(state.baselineScope==='user-selected-latest-head'&&selected?.head===state.anchor&&/^[a-f0-9-]{36}$/.test(selected.decisionId||'')){
  const base=require('./exchange-store').baseFor(dir),decision=JSON.parse(require('./regular-file').read(path.join(require('./data-layout').readerRoot(base),'gap-choices',selected.decisionId+'.json'))),step=decision.steps?.find(s=>s.kind===kind);
  if(decision.schema!==1||decision.status!=='committed'||decision.uid!==uid||decision.id!==selected.decisionId||step?.value?.anchor!==state.anchor||step.value.userSelectedHead?.decisionId!==decision.id||step.proof?.hash!==selected.proof?.hash)return false;
  const packet=I().restorePacket(selected.proof,dir),box=JSON.parse(require('./regular-file').read(packet.file)),items=C.rawArray(packet.raw,kind)?.items,first=items?.[0],row=first&&C.normalize(first,kind,uid);
  return box.query?.uid===uid&&box.query.kind===kind&&row?.recordId===state.anchor&&require('./record-body').completeBody(row,first)&&(kind!=='sent'||row.authorUid===uid);
 }
 const ref=state.connection;if(!ref||!/^update-connections\/[a-f0-9-]+\.json$/.test(ref.file||'')||!/^[a-f0-9]{64}$/.test(ref.hash||''))return false;
 const bytes=require('./regular-file').read(path.join(dir,'cache',ref.file));
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==ref.hash)return false;
 const proof=JSON.parse(bytes);if(proof.schema!==1||proof.uid!==uid||proof.kind!==kind||proof.upper!==state.anchor||!proof.packets?.length)return false;
 if(!proof.initial)return !!require('./regular-progress').connection(dir,kind,uid,{schema:1,id:proof.id,uid,kind,phase:'body',deltaComplete:true,anchor:proof.lower,head:proof.upper,since:true,deltaPackets:proof.packets.map(p=>p.sinceId===undefined?{...p,sinceId:proof.lower}:p)},null);
 const r=proof.packets[0],packet=I().restorePacket(r,dir),box=JSON.parse(require('./regular-file').read(packet.file)),q=box.query,items=C.rawArray(packet.raw,kind)?.items;
 if(items?.length===0)return require('./subscription-baseline').initialSavedHead(dir,kind,uid,proof.packets,proof.id)?.id===state.anchor;
 return box.schema===1&&q?.uid===uid&&q.kind===kind&&q.maxId===''&&q.page===1&&Array.isArray(items)&&items.length>0&&items.length<=q.count&&!C.apiError(packet.raw)&&String(items[0].idstr??items[0].id)===state.anchor&&items.every(item=>{const row=C.normalize(item,kind,uid);return row.recordId&&(!q.sinceId||BigInt(row.recordId)>BigInt(q.sinceId))&&require('./record-body').completeBody(row,item)&&(kind!=='sent'||row.authorUid===uid);});
}
function recheck(opts,dir,kind,state,fetchPage,persist){
 if(!state.sinceDisabled||!trustedHead(dir,kind,opts.uid,state))return null;
 const count=opts.autoGuard.maxCount(kind,1);if(count<1)throw require('./auto-follow-budget').safety(opts.autoGuard.stopCode,opts.autoGuard.stopReason);
 const maxId='',taskId=crypto.randomUUID();
 const packet=fetchPage({...opts,refresh:true,offline:false,dataTaskId:taskId},dir,kind,1,maxId,state.anchor),items=C.rawArray(packet.raw,kind)?.items;
 const ref={...(packet.receipt||{file:path.relative(dir,packet.file),hash:packet.responseHash}),count:1,maxId,sinceId:state.anchor};
 // Query and hash evidence must be durable before clearing the refusal flag.
 const restored=I().restorePacket(ref,dir),box=JSON.parse(require('./regular-file').read(restored.file)),q=box.query;
 const valid=box.schema===1&&q?.uid===opts.uid&&q.kind===kind&&q.taskId===taskId&&q.count===1&&q.maxId===maxId&&q.sinceId===state.anchor&&q.page===1&&!C.apiError(packet.raw)&&Array.isArray(items)&&items.length<=1&&(!items.length?require('./history').historyNext(packet.raw,kind)==='0':items.every(item=>{const row=C.normalize(item,kind,opts.uid);return row.recordId&&BigInt(row.recordId)>BigInt(state.anchor)&&(!maxId||BigInt(row.recordId)<=BigInt(maxId))&&require('./record-body').completeBody(row,item)&&(kind!=='sent'||row.authorUid===opts.uid);}));
 const recoveryFile=path.join(dir,'cache/update-boundary-recoveries',taskId+'.json');
 require('./durable-write').atomic(recoveryFile,{schema:1,uid:opts.uid,kind,originalState:state,request:ref,accepted:valid});
 state.boundaryRecovery={at:new Date().toISOString(),anchor:state.anchor,request:ref,accepted:valid,previousState:{file:path.relative(dir,recoveryFile),hash:require('./update-progress').token(recoveryFile)}};
 if(valid){
  state.sinceDisabled=false;
  // Start a fresh proof from the SAME old boundary. The prior unfinished chain
  // remains in the immutable recovery file; no gap is certified by the probe.
  state.pending={id:taskId,cursor:'',head:state.anchor,page:0,startedAt:new Date().toISOString(),packets:[],since:true};
 }
 persist(state);
 if(!valid)throw require('./auto-follow-budget').safety('AUTO_SINCE_IGNORED','原 since_id 单条核验仍不合规；保留订阅与旧范围，退避后再核对');
 return packet;
}
module.exports={trustedHead,recheck};
