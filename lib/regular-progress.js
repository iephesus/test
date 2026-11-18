'use strict';
// Reconcile a saved regular traversal with its global incremental state. A
// covered body quota and a connected new interval are deliberately separate.
// Only hash-bound, exact-request cursor chains may retire a stale pending head.
const fs=require('node:fs'),path=require('node:path');
const {rawArray,normalize,apiError}=require('./core'),{exactId}=require('./completeness');
function connection(dir,kind,uid,j,pending,{knownBodyIds}={}){
 const zero=kind==='post-comments'&&j?.anchor==='0'&&require('./post-subscription').verifiedBaseline(dir,uid,{uid,kind,anchor:'0',baselinePacket:j.verifiedEmptyBaseline,verifiedEmptyBaseline:j.verifiedEmptyBaseline});
 if(j?.schema!==1||j.uid!==uid||j.kind!==kind||!j.deltaComplete||j.phase!=='body'||j.scope?.from||j.scope?.to||!(exactId(j.anchor)||zero)||!(exactId(j.head)||zero&&j.head==='0')||BigInt(j.head)<BigInt(j.anchor))return null;
 if(pending&&((pending.anchor!==undefined&&j.anchor!==pending.anchor)||j.head!==pending.head))return null;
 const I=require('./incremental'),declared=j.deltaPackets?.length?j.deltaPackets:j.packets,first=declared?.[0];if(!first||first.maxId!=='')return null;
 const pool=[...declared],tasks=new Set([j.id,pending?.id]);
 function packet(ref,restored,cursor){
  if(!Number.isSafeInteger(ref.count)||ref.count<1||ref.count>200)return null;
  const p=restored||I.restorePacket(ref,dir);
  const q=p.query;
  if(ref.localReplay){
   if(!cursor||!['sent','received','post-comments'].includes(kind)||!j.since)return null;
   require('./request-journal').verifyContinuation(dir,ref,{uid,kind,maxId:cursor,sinceId:j.anchor});
  }
  if(q?.uid!==uid||q.kind!==kind||q.page!==1||(!ref.localReplay&&!tasks.has(q.taskId)))return null;
  if(q.count!==ref.count||q.maxId!==ref.maxId||q.sinceId!==(ref.sinceId||'')||q.sinceId&&BigInt(q.sinceId)>BigInt(j.anchor))return null;
  const a=rawArray(p.raw,kind);if(!a||apiError(p.raw)||a.items.length>q.count)return null;if(kind==='post-comments')require('./post-comments').postPageRows(p.raw,uid);
  const ids=a.items.map(r=>exactId(r.idstr??r.id));if(ids.some((id,i)=>!id||q.maxId&&BigInt(id)>BigInt(q.maxId)||q.sinceId&&BigInt(id)<=BigInt(q.sinceId)||i&&BigInt(id)>BigInt(ids[i-1])))return null;
  if(a.items.some(r=>{const row=normalize(r,kind,uid);return !Number.isFinite(row.ms)||kind==='sent'&&row.authorUid!==uid;}))return null;
  return {p,a,ids,ref:{...ref,...p.receipt,count:q.count,maxId:q.maxId,sinceId:q.sinceId}};
 }
 // Older regular journals lost the envelope marker when adopting a quick
 // packet. Infer it only after restorePacket checks the exact hash and query.
 const firstPacket=I.restorePacket(first,dir),firstQuery=firstPacket.query;
 if(firstQuery?.uid!==uid||firstQuery.kind!==kind||firstQuery.maxId!==''||firstQuery.sinceId!==(j.since?j.anchor:''))return null;
 if(typeof firstQuery.taskId!=='string'||!firstQuery.taskId)return null;tasks.add(firstQuery.taskId);
 if(!j.deltaPackets?.length){
  const root=path.join(dir,'cache/request-journal');if(fs.existsSync(root))for(const name of fs.readdirSync(root).filter(n=>/^[a-f0-9-]+\.response\.json$/.test(n))){
   try{const file=path.join(root,name),entry=require('./file-view-cache').fileView(file,'regular-proof',(box,meta)=>({box,hash:meta.hash()})),box=entry.box,q=box.query;
    if(box.schema!==1||q?.uid!==uid||q.kind!==kind||q.page!==1||!tasks.has(q.taskId))continue;
    pool.push({file:path.relative(dir,file),hash:entry.hash,envelope:true,uid,kind,page:1,count:q.count,maxId:q.maxId,sinceId:q.sinceId});
   }catch{/* A corrupt/unrelated receipt cannot establish a connection. */}
  }
 }
 const initial=packet(first,firstPacket);if(!initial)return null;
 if(initial.ids.length){if(initial.ids[0]!==j.head||!require('./record-body').completeBody(normalize(initial.a.items[0],kind,uid),initial.a.items[0]))return null;}
 else if(j.head!==j.anchor)return null;
 let cursor='',current=initial;const proofs=[],missing=new Set(),seen=new Set();let anonymous=0;
 for(let n=0;n<=pool.length;n++){
  if(!current||current.ref.maxId!==cursor||seen.has(cursor))return null;seen.add(cursor);proofs.push(current.ref);
  const values=current.a.container.miss_ids_str??current.a.container.miss_ids??[];if(!Array.isArray(values))return null;
  const safe=values.map(exactId).filter(id=>id&&BigInt(id)>BigInt(j.anchor)&&(!cursor||BigInt(id)<=BigInt(cursor)));
  for(const id of safe)missing.add(id);anonymous=Math.max(anonymous,Math.max(0,Number(current.a.container.miss_count||0)-safe.length));
  // A read-only caller may supply its validated body-ID projection solely to
  // contradict an empty terminal. It cannot certify a connection or a head.
  let known=[];if(!current.ids.length&&require('./history').historyNext(current.p.raw,kind)==='0')known=knownBodyIds?[...knownBodyIds]:[...require('./completeness').loadIndependentArchive(dir,kind,uid).records.keys()];
  const step=require('./update-end').updateStep(current.p.raw,kind,j.anchor,cursor,current.ids,{knownIds:known});if(step.ambiguous)return null;
  if(step.connected)return {id:j.id,scopes:j.ownerScopes||[],lower:j.anchor,upper:j.head,packets:proofs,missingIds:[...missing],unidentifiedMissing:anonymous};
  cursor=step.next;current=null;
  for(const ref of pool.filter(r=>r.maxId===cursor)){try{const candidate=packet(ref,null,cursor);if(candidate){current=candidate;break;}}catch{}}
 }
 return null;
}
function reconcile(dir,kind,uid,state){
 if(!state?.pending||!['sent','received'].includes(kind))return state;
 const I=require('./incremental'),P=require('./update-progress'),file=I.stateFile(dir,kind),expected=P.token(file),root=path.join(dir,'cache/data-updates');if(!fs.existsSync(root))return state;
 for(const name of fs.readdirSync(root).filter(n=>new RegExp('^'+kind+'_[a-f0-9]{16}\\.json$').test(n))){
  try{
   const j=JSON.parse(require('./regular-file').read(path.join(root,name),{maxBytes:16*1024*1024})),pending=state.pending;
   if(!Number.isFinite(Date.parse(j.lastAttemptAt||j.startedAt))||!['',...(j.ownerScopes||[])].some(taskScopeId=>path.basename(require('./data-update').progressFile(dir,kind,{beforeMs:null,taskScopeId}))===name))continue;
   if(j.anchor!==state.anchor||j.head!==pending.head||!(j.id===pending.id||j.packets?.[0]?.hash===pending.packets?.[0]?.hash))continue;
   const proof=connection(dir,kind,uid,j,{...pending,anchor:state.anchor});if(!proof)continue;
   const archive=require('./completeness').loadIndependentArchive(dir,kind,uid),gaps=new Set([...(state.gaps?.unresolvedIds||[]),...proof.missingIds]);for(const id of gaps)if(archive.records.has(id))gaps.delete(id);
   const value={...state,anchor:proof.upper,pending:null,checkedAt:j.lastAttemptAt||j.startedAt,endPolicyVersion:2,baselineUnverified:false,
    gaps:{...state.gaps,unresolvedIds:[...gaps],unidentifiedMissing:Math.max(state.gaps?.unidentifiedMissing||0,proof.unidentifiedMissing)},
    connectedProof:{...proof,scopes:[...new Set([...proof.scopes,...(pending.ownerScopes||[])])]},
    lastAttempt:{at:j.lastAttemptAt||j.startedAt,connected:true,reason:'已用保存的响应核实新增区间；历史缺失正文另行保留'},
    regularRecovery:{journalFile:path.relative(dir,path.join(root,name)),at:new Date().toISOString()}};
   const result=P.commit(file,expected,value);return result.ok?result.state:I.readState(dir,kind,uid);
  }catch{/* Preserve the pending interval when any required evidence is invalid. */}
 }
 return state;
}
module.exports={connection,reconcile};
