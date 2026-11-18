'use strict';
const core=require('./core'),{text,num,positiveId,esc,linkedText,userLink,postLink,replyPrefixParts,readingText,commentBodyHtml,copyButton,ts}=core;
const {provenanceBadge,provenanceDetails}=require('./completeness');
function directionOf(r){
  if(r.type==='发出'||r.type==='发出的评论')return 'sent';
  if(r.type==='收到'||r.type==='收到的评论')return 'received';
  return 'other';
}
function matchesDirection(row,direction){if(!direction)return true;if(!row||row.isContext)return false;const values=Array.isArray(row.directions)&&row.directions.length?row.directions:row.type==='发出/收到'?['sent','received']:[directionOf(row)];return values.includes(direction);}
function unreadDirection(r){if(!r||r.isContext||!r.isUnread)return '';const value=r.interactionDirection||directionOf(r);return ['sent','received'].includes(value)?value:'other';}
function unreadButtons(rows){const counts={sent:0,received:0,other:0};for(const row of rows){const d=unreadDirection(row);if(d)counts[d]++;}const labels={sent:'发出未读',received:'收到未读',other:'未读'};return Object.entries(counts).filter(([,n])=>n).map(([d,n])=>`<button type="button" class="group-unread-badge unread-${d}" data-unread-jump="${d}" title="此会话当前筛选范围内的${labels[d]}；点击展开并定位，可跨页">${labels[d]} ${n}</button>`).join('');}
function updateUnreadSummary(group,rows){const slot=group.firstElementChild.querySelector('[data-group-unread]');if(slot){slot.innerHTML=unreadButtons(rows);slot.hidden=!slot.childElementCount;}}
function beginUnreadNavigation(){
 focusUnreadRecord.pending?.abort();
 const pending=new AbortController();focusUnreadRecord.pending=pending;
 for(const type of ['wheel','touchstart','pointerdown','keydown','click','input','change','reader-ownership'])window.addEventListener(type,()=>pending.abort(),{once:true,passive:true,capture:true,signal:pending.signal});
 return pending;
}
function focusUnreadRecord(target,pending){
 if(!target){pending?.abort();return;}pending??=beginUnreadNavigation();if(pending.signal.aborted)return;
 for(const previous of document.querySelectorAll('.unread-record-focus'))previous.classList.remove('unread-record-focus');
 target.classList.add('unread-record-focus');target.tabIndex=-1;target.focus({preventScroll:true});
 // Smooth scrolling fixes its destination before lazy windows have their real
 // heights. Jump directly, then follow this exact node through bounded layout
 // frames; traversing intervening placeholders can otherwise end at the footer.
 let frames=0,stable=0,previous=null;
 function align(){
  if(pending.signal.aborted)return;
  if(!target.isConnected||!target.classList.contains('unread-record-focus')||target.closest('[hidden],details:not([open])')){pending.abort();return;}
  target.scrollIntoView({block:target.getBoundingClientRect().height>innerHeight-180?'start':'center',behavior:'instant'});
  const box=target.getBoundingClientRect(),current=[box.top,box.height,document.documentElement.scrollHeight];
  stable=previous&&current.every((n,i)=>Math.abs(n-previous[i])<1)?stable+1:0;previous=current;
  if(++frames<24&&stable<4)requestAnimationFrame(align);else pending.abort();
 }
 align();
}
function shortType(r){return directionOf(r)==='sent'?(r.shareView?'本人留言':'发出'):directionOf(r)==='received'?(r.shareView?'他人留言':'收到'):r.type;}

function timeTag(r,compact=false){
  const label=compact&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.time)?r.time.slice(11,16):r.time;
  const datetime=Number.isFinite(r.ms)?` datetime="${new Date(r.ms).toISOString()}"`:'';
  return `<time${datetime} title="${esc(r.time)}">${esc(label)}</time>`;
}
function detailsFor(r,compact=false,kindLabel=''){
 if(r.shareView)return require('./share-report').publicDetails(r,compact,kindLabel);
  const attrs=[['记录类型',kindLabel],['记录 ID',r.recordId],['原微博 ID',r.postId],['根评论 ID',r.rootId],['回复评论 ID',r.replyId]].filter(x=>x[1]);
  const users=[['评论作者',r.author,r.authorUid],['原微博作者',r.postAuthor,r.postAuthorUid],['回复对象',r.replyAuthor||r.displayReplyAuthor||replyPrefixParts(r.content)?.name,r.replyAuthorUid||r.displayReplyAuthorUid]].filter(x=>x[1]||x[2]);
  const lines=users.map(([k,name,uid])=>`<div><dt>${k}</dt><dd>${userLink(name,uid)}${uid?` · UID ${esc(uid)}`:''}</dd></div>`).join('')+attrs.map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  const raw=`${r.isContext?`<p class="context-label">${r.contextSource==='local-cache'?'来源：本地此前保存的同一对话记录，仅作为上下文展示，不计入本报告的正式条数或排行榜。分支内按时间排列不表示相邻消息直接互相回复。':'来源：其他评论附带的引用，未作为独立记录返回，不计入排行榜。'}</p>`:''}<div class="context-text"><strong>完整原文</strong><p>${commentBodyHtml(r,true)}</p></div>`;
  const parent=r.replyText?`<div class="context-text"><strong>被回复的评论 · ${userLink(r.replyAuthor,r.replyAuthorUid)}</strong>${r.replyTime?`<time>${esc(r.replyTime)}</time>`:''}<p>${linkedText(r.replyText)}</p><span class="context-label">${r.replyInRows?'本文件已有这条记录，此处仅供核对。':r.replyInConversation?'这条引用已按时间补充到对话中，不计入排行榜。':'接口附带的引用，未作为独立记录返回，不计入条数。'}</span></div>`:'';
  const post=r.postText&&!compact?`<div class="context-text"><strong>原微博正文</strong><p>${linkedText(r.postText)}</p></div>`:'';
  const label=compact?'···':'原文与详情';
  return `<details class="record-details${compact?' compact-details':''}"><summary title="查看完整原文、回复上下文和记录信息">${label}</summary><div class="record-details-body">${raw}${parent}${provenanceDetails(r)}<dl>${lines}</dl>${post}</div></details>`;
}
const {searchableName}=require('./search-text');
function searchFields(r){
  return esc([r.type,searchableName(r.author,r.authorUid),r.time,r.content,r.postId,searchableName(r.postAuthor,r.postAuthorUid),r.postText,r.recordId,r.rootId,r.replyId,searchableName(r.replyAuthor,r.replyAuthorUid),r.replyText,searchableName(r.peerName,r.peerUid)].join(' '));
}
function itemAttrs(r,i){return `data-item data-unread="${r.isUnread?'1':'0'}" data-direction="${esc((r.directions||[directionOf(r)]).join(','))}" data-comment-id="${esc(r.recordId)}" data-record="${i}" data-new="${r.isNew?'1':'0'}" data-kind="${esc(r.type)}" data-peer="${esc(r.peerKey)}" data-search="${searchFields(r)}" data-author-uid="${esc(positiveId(r.authorUid))}"`;}
function infoLink(r){return r.postId?postLink(r.postId,'',r.postLinkAuthor??r.postAuthorUid):'<span class="muted">无原微博 ID</span>';}
function unreadBadge(r){return !r.isContext&&r.isUnread?'<span class="unread-record-badge">未读</span>':'';}
function miniCard(r,i){
  const d=r.interactionDirection||directionOf(r);
  return `<article class="entry entry-${d}" ${itemAttrs(r,i)}>
    <div class="entry-top"><strong>${userLink(r.author,r.authorUid,r.authorUrl)}</strong>${provenanceBadge(r)}${unreadBadge(r)}${r.isNew?'<span class="new-record-badge">新增</span>':''}<time>${esc(r.time)}</time></div>
    <div class="entry-content">${commentBodyHtml(r)}</div>
    <div class="entry-bottom"><span>${r.postId?`原微博 ${infoLink(r)}`:''}</span>${detailsFor(r,false,shortType(r))}</div></article>`;
}
function dayKey(r){return /^\d{4}-\d{2}-\d{2}/.test(r.time)?r.time.slice(0,10):'未知日期';}
function timelineHtml(rows){
  let last='',out='';
  rows.forEach((r,i)=>{const d=dayKey(r);if(d!==last){out+=`<div class="day-divider" data-day-group><span data-day="${esc(d)}">${esc(d)}</span></div>`;last=d;}out+=miniCard(r,i);});
  return out;
}

function browserTemplates(publicView=false){
 const dependencies=['text','num','positiveId','esc','linkedText','userLink','postLink','replyPrefixParts','readingText','unescapeEntities','pictureUrl','commentPictureViewer','commentShortUrl','commentMediaEntries','commentMediaUrls','commentBodyHtml','copyButton','ts'];
 return 'const {parsePostTarget,postUrl,postUrls,displayPostUrl,commentUrl}=('+require('./post-links').createPostLinks.toString()+')();\n'+require('./date-range').formatTimestamp.toString()+'\n'+dependencies.map(k=>'const '+k+'='+core[k].toString()+';').join('\n')+'\n'+[...(publicView?[function provenanceBadge(){return '';},function provenanceDetails(){return '';}]:[provenanceBadge,provenanceDetails]),require('./reader-layout').layoutConversation,directionOf,matchesDirection,unreadDirection,unreadButtons,updateUnreadSummary,beginUnreadNavigation,focusUnreadRecord,shortType,timeTag,searchableName,...(publicView?[require('./share-report').publicDetails]:[detailsFor]),searchFields,itemAttrs,infoLink,unreadBadge,miniCard,dayKey,timelineHtml].map(fn=>fn.name==='publicDetails'?'const detailsFor='+fn.toString()+';':fn.toString()).join('\n');
}
module.exports={unreadBadge,directionOf,matchesDirection,unreadDirection,unreadButtons,updateUnreadSummary,beginUnreadNavigation,focusUnreadRecord,shortType,timeTag,detailsFor,searchFields,itemAttrs,infoLink,miniCard,dayKey,timelineHtml,browserTemplates};
