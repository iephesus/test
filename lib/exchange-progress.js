'use strict';
// A foreign head is never compared with Math.max. Its chain must prove the jump.
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const S=require('./exchange-schema'),{rawArray}=require('./core');
function verifyChain(proof,packets,{initial=false,anchor='',target=null,pending=false,knownIds=[]}={}){
 if(!Array.isArray(proof)||!proof.length)throw Error('缺少完整请求链');let cursor='',head='',covered=0,ended=false;const unique=new Set();
 for(let i=0;i<proof.length;i++){
  const p=packets.get(proof[i]);if(!p||p.trusted!==true)throw Error('引用的响应未完整携带或边界未验证');require('./exchange-records').validatePacket(p);
  const q=p.query,items=rawArray(p.response,p.channel).items,ids=items.map(r=>S.id(r.idstr??r.id??r.mid));
  if(q.maxId!==cursor||initial&&q.sinceId||!initial&&q.sinceId&&q.sinceId!==anchor)throw Error('请求链边界不连续');
  if(items.some(r=>!require('./record-body').completeBody(require('./core').normalize(r,p.channel,p.owner.id),r)))throw Error('请求链存在不完整独立正文');
  const box=rawArray(p.response,p.channel).container;if(Number(box.miss_count)>0||(box.miss_ids_str||box.miss_ids||[]).length)throw Error('请求链含缺失位置，不能移植成功起点');
  if(!head&&ids.length)head=ids[0];for(const id of ids)unique.add(id);covered=unique.size;
  if(initial){const next=require('./history').historyNext(p.response,p.channel);if(!ids.length&&next==='0'){ended=true;cursor='0';}else cursor=next&&next!=='0'?next:ids.length?(BigInt(ids.at(-1))-1n).toString():'';if(!cursor)throw Error('响应未证明续取位置');}
  else{const step=require('./update-end').updateStep(p.response,p.channel,anchor,cursor,ids,{knownIds});if(step.ambiguous)throw Error('响应结束含义不明确');ended=step.connected;cursor=step.next||'';}
  if(ended&&i!==proof.length-1)throw Error('已结束区间后仍有其他响应');
 }
 if(initial&&!(target!=null?covered>=target:ended))throw Error('无法证明首次目标范围已完整覆盖');
 if(!initial&&!pending&&!ended)throw Error('新增区间未完整接回原起点');
 return {head,cursor,covered,ended};
}
// Identical local progress is retained, not certified as foreign progress.
// This comparison cannot advance a head or clear a pending interval.
function unchanged(value,current,dir){
 if(!current||current.uid!==value.owner?.id||current.kind!==value.channel)return false;
 const st=value.state,keys=['uid','kind','anchor','checkedAt','endPolicyVersion','baselineUnverified','sinceDisabled'];
 if(!st||keys.some(k=>(st[k]??false)!==(current[k]??false)))return false;
 if(S.stable(st.scope||{})!==S.stable({recentLimit:current.scope?.recentLimit??null,olderHistoryComplete:false}))return false;
 if(!!st.pending!==!!current.pending)return false;
 if(st.pending){const a=st.pending,b=current.pending;for(const k of ['cursor','head','startedAt','verify','since'])if((a[k]??false)!==(b[k]??false))return false;const refs=b.packets||[];if(refs.length!==a.packets?.length)return false;try{for(const ref of refs)require('./incremental').restorePacket(ref,dir);}catch{return false;} // Never adopt the foreign cursor: retain our exact validated local references.
 }
 return true;
}
function validate(value,packets,current){
 const o=S.owner(value.owner),kind=S.channel(o,value.channel);for(const c of [...(value.connections||[]),...(value.state?.pending?[value.state.pending]:[])])for(const h of c.packets||[]){const packet=packets.get(h);if(!packet||S.key(packet.owner)!==S.key(o)||packet.channel!==kind)throw Error('连接响应属于其他对象或方向');}if(o.kind!=='user'||!['sent','received','mentions-comments','mentions-posts'].includes(kind))throw Error('此类进度仅保留证据，暂不移入成功起点');
 const st=value.state;if(st?.scope?.recentLimit!=null&&(!Number.isSafeInteger(st.scope.recentLimit)||st.scope.recentLimit<1))throw Error('首次覆盖范围无效');if(!st||st.uid!==o.id||st.kind!==kind||st.endPolicyVersion!==2||st.baselineUnverified||!Number.isFinite(Date.parse(st.checkedAt)))throw Error('成功进度的身份或版本未核实');S.id(st.anchor);
 const knownIds=[...(current?.knownIds||[]),...(packets.knownIds?packets.knownIds(o,kind):[...packets.values()].filter(p=>S.key(p.owner)===S.key(o)&&p.channel===kind).flatMap(p=>rawArray(p.response,kind).items.map(r=>S.id(r.idstr??r.id??r.mid))))];let accepted=false,chain=null;
 if(!current){const proof=value.connections?.find(c=>c.initial&&c.upper===st.anchor);if(!proof)throw Error('缺少可验证的初始范围证据');chain=verifyChain(proof.packets,packets,{initial:true,target:st.scope?.recentLimit??null});if(chain.head!==st.anchor)throw Error('成功起点不等于已验证响应头部');accepted=true;}
 else if(current.anchor===st.anchor)accepted=true;
 else if(!current.pending){const proof=value.connections?.find(c=>c.lower===current.anchor&&c.upper===st.anchor&&!c.initial);if(!proof)throw Error('双方起点之间没有可连接证据');chain=verifyChain(proof.packets,packets,{anchor:current.anchor,knownIds});if(chain.head!==st.anchor)throw Error('请求链不支持目标成功位置');accepted=true;}
 if(!accepted)throw Error('本地有独立待续区间，保留本地成功位置');
 if(current&&BigInt(st.anchor)<BigInt(current.anchor))throw Error('导入进度不能回退本地起点');
 let continuation=null;
 if(st.pending&&!current?.pending){if(value.unknownOutcome)throw Error('导出端存在结果未知的请求，仅保留正文及区间证据');const pending=st.pending,c=verifyChain(pending.packets,packets,{anchor:st.anchor,pending:true});if(c.ended||c.cursor!==pending.cursor||c.head!==pending.head)throw Error('待续位置与响应链不一致');continuation={...pending,id:crypto.randomUUID(),ownerScopes:[],page:pending.packets.length};}
 return {state:st,pending:continuation,chain};
}
function exportProgress(dir,o,kind,sourceMap){
 const file=require('./incremental').stateFile(dir,kind);if(!fs.existsSync(file))return null;
 const state=JSON.parse(fs.readFileSync(file));if(state.uid!==o.id||state.kind!==kind)return null;
 function refs(list){if(!Array.isArray(list))return [];return list.map(ref=>{require('./incremental').restorePacket(ref,dir);const original=path.resolve(dir,ref.file);const h=sourceMap.get(original);if(!h)throw Error('进度引用未携带或不支持的响应');return h;});}
 const connections=[];let ref=state.connection,n=0;
 while(ref){if(n++>64||!/^update-connections\/[a-f0-9-]+\.json$/.test(ref.file||''))throw Error('连接链过长或路径异常');const f=path.join(dir,'cache',ref.file);if(require('./update-progress').token(f)!==ref.hash)throw Error('连接证据哈希不匹配');const c=JSON.parse(fs.readFileSync(f));if(c.uid!==o.id||c.kind!==kind)throw Error('连接证据对象不一致');connections.push({initial:!!c.initial,lower:c.lower||'',upper:c.upper,packets:refs(c.packets)});ref=c.previous;}
 if(!connections.length&&state.proof)connections.push({initial:true,lower:'',upper:state.anchor,packets:refs(state.proof)});
 const st={uid:o.id,kind,anchor:state.anchor,checkedAt:state.checkedAt,endPolicyVersion:state.endPolicyVersion,origin:state.origin||'',baselineUnverified:!!state.baselineUnverified,sinceDisabled:!!state.sinceDisabled,scope:{recentLimit:state.scope?.recentLimit??null,olderHistoryComplete:false}};
 if(state.pending)st.pending={cursor:state.pending.cursor,head:state.pending.head,startedAt:state.pending.startedAt,verify:!!state.pending.verify,since:!!state.pending.since,packets:refs(state.pending.packets)};
 let unknownOutcome=false;const j=path.join(dir,'cache/request-journal');if(fs.existsSync(j))for(const name of fs.readdirSync(j).filter(n=>n.endsWith('.request.json'))){const q=JSON.parse(fs.readFileSync(path.join(j,name)));if(q.query?.kind===kind&&q.query?.taskId===state.pending?.id&&['inflight','unknown'].includes(q.status)&&!fs.existsSync(path.join(j,name.replace('.request.json','.response.json'))))unknownOutcome=true;}
 return {schema:1,role:'progress',owner:o,channel:kind,state:st,connections,unknownOutcome};
}
module.exports={unchanged,verifyChain,validate,exportProgress};
