'use strict';
// Display order only. Keep actual timestamps and reply relationships intact.
function exactIdOrder(a,b){
 const id=value=>typeof value==='string'&&/^[1-9]\d{4,19}$/.test(value)?value:'';
 a=id(a);b=id(b);
 return a.length-b.length||(a<b?-1:a>b?1:0);
}
function orderTies(rows,pages=[]){
 const groups=new Map(),byId=new Map();
 for(const row of rows){
  if(row.group!=='post-comments'||row.isContext||!Number.isFinite(row.ms)||typeof row.recordId!=='string'||!/^[1-9]\d{4,19}$/.test(row.recordId))continue;
  if(!groups.has(row.ms))groups.set(row.ms,[]);
  const ids=groups.get(row.ms);ids.push(row.recordId);byId.set(row.recordId,row.ms);
 }
 const tied=new Map([...groups].filter(([,ids])=>ids.length>1)),constraints=new Map();
 for(const page of pages){
  const last=new Map();
  for(const item of page){
   const ms=byId.get(item.id);
   if(!tied.has(ms)||item.ms!==ms||!['minute','second'].includes(item.timePrecision))continue;
   const newer=last.get(ms);
   if(newer&&newer!==item.id){
    if(!constraints.has(ms))constraints.set(ms,new Map());
    const edges=constraints.get(ms);
    if(!edges.has(item.id))edges.set(item.id,new Set());
    edges.get(item.id).add(newer);
   }
   last.set(ms,item.id);
  }
 }
 const rank=new Map();
 for(const [ms,ids]of tied){
  const stable=[...new Set(ids)].sort(exactIdOrder),edges=constraints.get(ms)||new Map(),degree=new Map(stable.map(id=>[id,0]));
  for(const newer of edges.values())for(const id of newer)degree.set(id,degree.get(id)+1);
  const ordered=[],ready=stable.filter(id=>degree.get(id)===0);
  while(ready.length){
   const id=ready.shift();ordered.push(id);
   for(const next of edges.get(id)||[]){degree.set(next,degree.get(next)-1);if(degree.get(next)===0){ready.push(next);ready.sort(exactIdOrder);}}
  }
  (ordered.length===stable.length?ordered:stable).forEach((id,index)=>rank.set(id,index));
 }
 return rank;
}
function savedPages(dir,postId,rows){
 if(!orderTies(rows).size)return [];
 const path=require('node:path'),fs=require('node:fs'),regular=require('./regular-file'),stores=require('./legacy-web-evidence');
 const folder=path.join(dir,'cache','crawler-v1'),pages=[],wanted=new Set(rows.map(row=>row.recordId));
 let receiptsLeft=128,fingerprintsLeft=192;
 try{
  if(!fs.lstatSync(folder).isDirectory())return pages;
  const scopes=fs.readdirSync(folder,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^[a-f0-9]{64}$/.test(e.name));
  if(scopes.length>64)return pages;
  for(const item of scopes)try{
   if(!receiptsLeft)break;
   const scoped=path.join(folder,item.name),state=JSON.parse(regular.read(path.join(scoped,'progress.json'),{maxBytes:2*1024*1024}));
   if(state.id!==postId||!['post','post-follow','post-check'].includes(state.kind))continue;
   const store=stores.open(dir,{scope:state.scope,kind:state.kind,id:postId});
   if(store.folder!==scoped)continue;
   const proofs=new Map(),add=proof=>{
    if(/^[a-f0-9-]{36}$/.test(proof?.id||'')&&/^[a-f0-9]{64}$/.test(proof.hash||'')&&(!proof.kind||proof.kind===state.kind)&&!proofs.has(proof.id))proofs.set(proof.id,proof);
   };
   add(state.lastReceipt);add(state.homeReceipt);add(state.head?.receipt);
   for(const connection of [state.head?.connection,state.pending]){
    for(const fragment of [...(connection?.pages||[]),...(connection?.fragments||[]),...(connection?.checks||[]),...(connection?.verification?.receipts||[])])add(fragment.proof);
   }
   const fingerprints=path.join(scoped,'fingerprints');
   if(fingerprintsLeft&&state.kind==='post'&&fs.existsSync(fingerprints)&&fs.lstatSync(fingerprints).isDirectory()){
    const rounds=fs.readdirSync(fingerprints,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^[a-f0-9-]{36}$/.test(e.name));
    const latest=rounds.map(e=>({name:e.name,mtime:fs.statSync(path.join(fingerprints,e.name)).mtimeMs})).sort((a,b)=>Number(b.name===state.round)-Number(a.name===state.round)||b.mtime-a.mtime);
    for(const round of latest.slice(0,4)){
     for(const file of regular.list(path.join(fingerprints,round.name),/^[a-f0-9]{64}\.json$/).slice(0,Math.min(64,fingerprintsLeft))){
      fingerprintsLeft--;
      const value=JSON.parse(regular.read(file,{maxBytes:4096}));if(value.schema===1)add({id:value.requestId,hash:value.receiptHash});
     }
    }
   }
   for(const proof of proofs.values())try{
    if(!receiptsLeft)break;
    receiptsLeft--;
    const {value:{request,parsed}}=store.receipt(proof),ordinary=parsed.ordinary;
    if(request.status===200&&parsed.flowVersion===1&&!parsed.candidateOnly&&Array.isArray(ordinary)){
     const matched=ordinary.filter(item=>wanted.has(item.id));if(matched.length>1)pages.push(matched);
    }
   }catch{/* An unavailable receipt supplies no display-order evidence. */}
  }catch{/* A different or damaged scope cannot affect ordering. */}
 }catch{/* No crawler archive. Stable exact-ID ordering still applies. */}
 return pages;
}
function savedRanks(dir,postId,rows){
 return Object.fromEntries(orderTies(rows,savedPages(dir,postId,rows)));
}
function applySavedOrder(postId,rank){
 const payload=JSON.parse(document.getElementById('weibo-report-records').textContent),times=new Map(payload.rows.filter(r=>r.group==='post-comments'&&r.postId===postId&&!r.isContext).map(r=>[r.recordId,r.ms]));
 function reorder(items,idOf){
  const slots=new Map(),result=items.slice();
  items.forEach((item,index)=>{
   const id=idOf(item);if(!Object.hasOwn(rank,id)||!times.has(id))return;
   const ms=times.get(id);if(!slots.has(ms))slots.set(ms,[]);slots.get(ms).push(index);
  });
  for(const indexes of slots.values()){
   const ordered=indexes.map(i=>items[i]).sort((a,b)=>rank[idOf(a)]-rank[idOf(b)]);
   indexes.forEach((index,i)=>{result[index]=ordered[i];});
  }
  return result;
 }
 function reorderBody(root){
  const items=[...root.querySelectorAll('article[data-item][data-comment-id]')],ordered=reorder(items,n=>n.dataset.commentId);
  if(ordered.every((node,i)=>node===items[i]))return;
  const markers=items.map(node=>{const mark=document.createComment('');node.replaceWith(mark);return mark;});
  markers.forEach((marker,i)=>marker.replaceWith(ordered[i]));
 }
 for(const group of document.querySelectorAll('#conversation [data-post-group]')){
  if(group.dataset.postId!==postId)continue;
  const lazy=group.querySelector('script[data-lazy-thread]');
  if(!lazy){reorderBody(group.querySelector('.thread-body')||group);continue;}
  const data=JSON.parse(lazy.textContent);
  if(typeof data==='string'){
   const template=document.createElement('template');template.innerHTML=data;reorderBody(template.content);lazy.textContent=JSON.stringify(template.innerHTML);
  }else if(Array.isArray(data?.entries)){
   data.entries=reorder(data.entries,e=>e.context?'':payload.rows[e.index]?.recordId);
   lazy.textContent=JSON.stringify(data);
  }
 }
}
module.exports={exactIdOrder,orderTies,savedRanks,applySavedOrder};
