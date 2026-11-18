"use strict";
// Native browser success alone authorizes exact reading receipts. File pins are
// shared with CLI retention and do not carry reading-state authority.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const catalogue=require('../lib/report-catalog'),inbox=require('../lib/follow-inbox'),lifecycle=require('../lib/report-lifecycle'),regular=require('../lib/regular-file');
function formalReceiptIds(html,uid,postId,verified){
 const exact=value=>{const id=require('../lib/completeness').exactId(value);return id&&String(value)===id?id:'';},ids=new Set();
 // The generated, hash-verified format can use its exact serialization. Old
 // files without that proof need the actual document node, not an inert lookalike.
 const generated=verified&&html.match(/<\/main>\s*<script type="application\/json" id="(?:weibo-report-records|weibo-merged-records)">([\s\S]*?)<\/script>/);
 const tree=generated?null:require('parse5').parse(html,{sourceCodeLocationInfo:true});
 const payload=generated?{text:generated[1]}:require('../lib/report-records').locateReportPayload(html,tree);
 if(payload?.invalid)return null;
 if(payload){
  let value;try{value=JSON.parse(payload.text);}catch{return null;}
  if(value?.uid!==uid||!Array.isArray(value.rows))return null;
  for(const row of value.rows){
   if(!row||typeof row!=='object')return null;if(row.isContext)continue;
   // The user inbox tracks comments. An equal-numbered mentioned post is a
   // different formal object and cannot acknowledge a comment's reading state.
   if(['mentions-posts','user-posts'].includes(row.group))continue;
   if(typeof row.content!=='string'||!exact(row.recordId))return null;
   if(postId){if(row.group!=='post-comments'||exact(row.postId)!==postId)return null;}
   else if(!['sent','received','both','mentions-comments'].includes(row.group))return null;
   // The unread shortcut includes older items for context. Its receipt only
   // acknowledges the records flagged unread in the captured report.
   if(value.unreadContext!==true||row.isUnread===true)ids.add(exact(row.recordId));
  }
 }else{
  // Old reports can still prove their own formal selection. Private snapshots
  // alone cannot: a catalogue entry may predate a changed or replaced HTML file.
  let scoped=false,invalid=false;
  const commentKinds=new Set(['发出的评论','收到的评论','发出/收到','发出','收到','双向评论（无法判定方向）','被@的评论']);
  function walk(node,owner='',context=false){
   const a=Object.fromEntries((node.attrs||[]).map(x=>[x.name,x.value]));
   if(node.tagName==='body')scoped=a['data-target-uid']===uid&&a['data-color-mode']===(postId?'posts':'users');
   if(Object.hasOwn(a,'data-post-group'))owner=a['data-post-id']||'';context=context||Object.hasOwn(a,'data-context');
   if(scoped&&!context&&['article','tr'].includes(node.tagName)&&Object.hasOwn(a,'data-item')){
    const kind=a['data-kind'];
    if(!postId&&kind==='被@的微博')return;
    if(!exact(a['data-comment-id'])||(postId?owner!==postId||!['评论','回复','微博下的评论'].includes(kind):!commentKinds.has(kind)))invalid=true;
    else ids.add(a['data-comment-id']);
   }
   for(const child of node.childNodes||[])walk(child,owner,context);
  }
  walk(tree);if(!scoped||invalid)return null;
 }
 return ids.size?[...ids]:null;
}
function createReportAccess(workspace,{now=Date.now,ttlMs=15*60000}={}){
 const tickets=new Map(),handoffs=new Map(),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 function releaseHandoff(token,h){
  // A file pin is auxiliary. Once its reading ticket is consumed, a failed
  // release must never turn a committed exact-ID receipt into a read failure.
  h.settled=true;
  try{h.pin.release();handoffs.delete(token);}catch{lifecycle.resume(workspace);}
 }
 function dispose(token){const ticket=tickets.get(token);tickets.delete(token);for(const [key,h]of handoffs)if(h.unreadTicket===token)releaseHandoff(key,h);return ticket;}
 function open(id,kind='report'){return lifecycle.locked(workspace,()=>{
  const library=require('./library'),normalizeId=require('../lib/report-catalog').normalizeId;id=normalizeId(id);const file=library.containedReport(workspace,id);kind=kind==='folder'?'folder':'report';if(kind==='folder')return {id,kind,path:path.dirname(file),unreadTicket:null,handoffTicket:null};
  for(const [token,h]of handoffs)if(h.settled)releaseHandoff(token,h);
  if(handoffs.size>=32)throw Error('请先等待之前的报告交给浏览器，再打开更多报告');
  const snapshot=require('./report-reader-repair').prepareReportReader(workspace,id,file);
  const meta=snapshot.entry,category=id.split('/')[0],folder=id.split('/')[1],mapping=category==='user-comments'?require('../lib/storage').indexRead(require('../lib/storage').storagePaths(workspace).users):{},mappedUid=Object.entries(mapping).find(([,v])=>v.folder===folder)?.[0]||'',uid=meta?.uid||mappedUid||'',folderPostId=category==='post-comments'?require('../lib/storage').postIdFromFolder(folder):'',postId=category==='post-comments'?(meta?.postId||folderPostId):'';
  const valid=value=>typeof value==='string'&&/^[1-9]\d{4,19}$/.test(value),scoped=category==='user-comments'?valid(uid)&&(!mappedUid||mappedUid===uid):category==='post-comments'&&valid(postId)&&(!folderPostId||folderPostId===postId)&&(!uid||valid(uid));
  let unreadTicket=null;
  if(scoped&&(category==='user-comments'&&fs.existsSync(inbox.file(workspace,uid))||category==='post-comments'&&fs.existsSync(require('../lib/post-reading-state').file(workspace,postId))))try{
   const bytes=snapshot.bytes??regular.read(file),digest=snapshot.digest??hash(bytes);if(!meta?.localHash||meta.localHash===digest){const ids=formalReceiptIds(bytes.toString('utf8'),uid,postId,meta?.localHash===digest);if(ids){unreadTicket=crypto.randomUUID();tickets.set(unreadTicket,{uid,postId,id,hash:digest,ids,expires:now()+ttlMs});}}
  }catch{/* Missing old formal evidence prevents read marking, while opening remains available. */}
  const handoffTicket=crypto.randomUUID();let pin;try{pin=lifecycle.pin(workspace,id,{ttlMs,onExpire(){tickets.delete(unreadTicket);handoffs.delete(handoffTicket);}});}catch(error){tickets.delete(unreadTicket);throw error;}
  handoffs.set(handoffTicket,{id,unreadTicket,pin});return {id,kind,path:file,unreadTicket,handoffTicket};
 });}
 function opened(token){return lifecycle.locked(workspace,()=>{
  const ticket=tickets.get(token);if(!ticket)return null;if(now()>ticket.expires){dispose(token);return null;}
  const file=catalogue.contained(workspace,ticket.id);if(hash(regular.read(file))!==ticket.hash)throw Error('报告内容已变化，未修改已读状态');
  let result=null;if(ticket.postId)result={uid:'',targetKind:'post',postId:ticket.postId,id:ticket.id,...require('../lib/post-reading-state').markRead(workspace,ticket.postId,ticket.ids)};
  else if(fs.existsSync(inbox.file(workspace,ticket.uid)))result={uid:ticket.uid,id:ticket.id,...inbox.markRead(workspace,ticket.uid,ticket.ids)};
  dispose(token);return result;
 });}
 function handedOff(token,success){return lifecycle.locked(workspace,()=>{
  const pending=handoffs.get(token);if(!pending)return null;if(pending.settled){releaseHandoff(token,pending);return null;}const result=success&&pending.unreadTicket?opened(pending.unreadTicket):null;
  if(handoffs.has(token)&&!pending.settled){if(pending.unreadTicket)tickets.delete(pending.unreadTicket);releaseHandoff(token,pending);}return {id:pending.id,result,...(handoffs.has(token)?{cleanupPending:true}:{})};
 });}
 return {open,opened,handedOff,pendingReports:()=>[...new Set([...handoffs.values()].map(p=>p.id))],close(){for(const [token,h]of handoffs)releaseHandoff(token,h);tickets.clear();}};
}
module.exports={createReportAccess};
