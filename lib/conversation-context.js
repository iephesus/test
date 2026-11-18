'use strict';
const {loadIndependentArchive,exactId}=require('./completeness');

// These rows remain display context. Never add them to endpoint quotas or rankings.
function localConversationContext(rows,dir,uid,options={},load=loadIndependentArchive){
 if(options.historyRecovery===false||options.mode!=='sent')return [];
 const formal=new Set(rows.map(r=>r.postId+':'+r.recordId)),branches=new Map(),parents=new Map(),selected=new Map();
 rows.forEach((r,index)=>{
  if(r.authorUid!==uid||!exactId(r.postId)||!exactId(r.recordId))return;
  selected.set(r.postId+':'+r.recordId,index);
  if(exactId(r.replyId)){
   const key=r.postId+':'+r.replyId;if(!parents.has(key))parents.set(key,[]);parents.get(key).push(index);
  }
  const peer=r.replyAuthorUid||(r.rootId===r.recordId?r.postAuthorUid:'');
  if(!exactId(r.rootId)||!exactId(peer)||peer===uid||!Number.isFinite(r.ms))return;
  const key=[r.postId,r.rootId,peer].join(':');
  if(!branches.has(key))branches.set(key,[]);branches.get(key).push({index,row:r});
 });
 const archive=load(dir,'received',uid),contexts=[];
 for(const {row,provenance}of archive.records.values()){
  if(!exactId(row.postId)||!exactId(row.recordId)||!exactId(row.authorUid)||row.authorUid===uid||!Number.isFinite(row.ms)||!String(row.content||'').trim())continue;
  const key=row.postId+':'+row.recordId;if(formal.has(key))continue;
  if(Number.isFinite(options.beforeMs)&&row.ms>options.beforeMs)continue;
  const direct=parents.get(key)||[],branch=branches.get([row.postId,row.rootId,row.authorUid].join(':'))||[];
  let refs=[...direct];
  const replyTo=selected.get(row.postId+':'+row.replyId);
  if(Number.isInteger(replyTo)&&row.ms>=rows[replyTo].ms)refs.push(replyTo);
  // A shared root proves branch membership, not a direct reply between neighbors.
  if(!refs.length&&branch.length){
   const sorted=branch.slice().sort((a,b)=>a.row.ms-b.row.ms),first=sorted[0].row.ms,last=sorted.at(-1).row.ms;
   if(row.ms<first||row.ms>last)continue;
   const preceding=sorted.filter(v=>v.row.ms<=row.ms).at(-1),following=sorted.find(v=>v.row.ms>=row.ms);
   refs=[preceding?.index,following?.index].filter(Number.isInteger);
  }
  if(!refs.length)continue;
  contexts.push({...row,isContext:true,isRecovered:false,contextSource:'local-cache',contextFor:[...new Set(refs)],contextSortMs:row.ms,
   type:'引用补充',group:'context',targetUid:uid,interactionDirection:'received',peerKey:'context',peerUid:'',peerName:'',provenance});
 }
 return contexts;
}
module.exports={localConversationContext};
