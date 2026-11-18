'use strict';
// On-demand, hash-verified compatibility for managed reports. Only generated
// controls change; portable records, original text and read receipts stay intact.
const links=require('../lib/post-links'),core=require('../lib/core'),{esc,unescapeEntities,CONTENT_LINK_VERSION}=core;
const POST_LINK_VERSION='7';
function upgradePostLinks(createPostLinks,renderLink,authors,hasRecords){
 const links=createPostLinks();
 function heading(origin){
  const label=origin.querySelector('.source-label');
  if(label&&label.textContent!=='原微博作者：')label.textContent='原微博作者：';
  for(const pair of origin.querySelectorAll('.post-link-pair')){
   const labels=[...pair.querySelectorAll('.post-link-label')];let source=labels.shift();
   if(!source){source=document.createElement('span');source.className='post-link-label';pair.prepend(source);}
   if(source.textContent!=='原文：')source.textContent='原文：';
   for(const duplicate of labels)duplicate.remove();
  }
 }
 function update(a){
  if(a.matches('.content-link,[data-post-site]')||a.closest('.post-link-pair'))return;
  const old=a.getAttribute('href');if(!links.displayPostUrl(old))return;
  const id=links.parsePostTarget(old);let uid=authors[id]||'';
  // User-post reports have no portable comment payload. An explicit author UID
  // in their generated control is usable; never borrow from a neighboring user.
  if(!hasRecords){const url=new URL(old);uid=/^(?:www\.)?weibo\.cn$/.test(url.hostname)?url.searchParams.get('uid')||'':'';}
  const holder=document.createElement('span');holder.innerHTML=renderLink(id,a.closest('.post-origin-line')?'原文：':a.textContent.replace(/\s*↗\s*$/,''),uid);a.replaceWith(...holder.childNodes);
 }
 function scan(root){if(root.nodeType!==1)return;const origin=root.closest('.post-origin-line');if(origin)heading(origin);for(const line of root.querySelectorAll('.post-origin-line'))heading(line);if(root.matches('a[href]'))update(root);for(const a of root.querySelectorAll('a[href]'))update(a);}
 scan(document.documentElement);
 new MutationObserver(changes=>{for(const change of changes)for(const node of change.addedNodes)scan(node);}).observe(document.documentElement,{subtree:true,childList:true});
}
function upgradeContentLinks(linkedText){
 function update(a){if(a.closest('[data-comment-pictures],.comment-picture-links'))return;const raw=a.textContent,holder=document.createElement('span');holder.innerHTML=linkedText(raw);if(holder.childNodes.length!==1||holder.firstElementChild?.textContent!==raw)a.replaceWith(...holder.childNodes);}
 function scan(root){if(root.nodeType!==1)return;if(root.matches('a.content-link'))update(root);for(const a of root.querySelectorAll('a.content-link'))update(a);}
 scan(document.documentElement);
 new MutationObserver(changes=>{for(const change of changes)for(const node of change.addedNodes)scan(node);}).observe(document.documentElement,{subtree:true,childList:true});
}
function upgradeCommentPictures(renderBody){
 const payload=JSON.parse(document.getElementById('weibo-report-records').textContent),indexed=new Map(),byKey=new Map(),byId=new Map(),done=new WeakSet();
 function add(row,index){if(!row||!renderBody(row).includes('data-comment-pictures'))return;const key=row.postId+'|'+row.recordId,old=byKey.get(key);if(byKey.has(key)&&JSON.stringify(old)!==JSON.stringify(row))byKey.set(key,null);else byKey.set(key,row);if(byId.has(row.recordId)&&JSON.stringify(byId.get(row.recordId))!==JSON.stringify(row))byId.set(row.recordId,null);else byId.set(row.recordId,row);if(index!=null)indexed.set(String(index),row);}
 payload.rows.forEach(add);(payload.context||[]).forEach(row=>add(row,null));
 function update(node){
  if(done.has(node))return;done.add(node);const id=node.dataset.commentId,post=node.closest('[data-post-group]')?.dataset.postId,candidate=indexed.get(node.dataset.record);let row;
  if(!node.hasAttribute('data-context')&&candidate?.recordId===id&&(!post||candidate.postId===post))row=candidate;
  else row=post?byKey.get(post+'|'+id):byId.get(id);
  if(!row||row.recordId!==id)return;
  for(const body of node.querySelectorAll('.bubble-content,.entry-content'))if(body.closest('[data-item],[data-context]')===node)body.innerHTML=renderBody(row);
  for(const block of node.querySelectorAll('.record-details-body .context-text'))if(block.firstElementChild?.textContent==='完整原文'){const p=block.querySelector('p');if(p)p.innerHTML=renderBody(row,true);}
 }
 function scan(root){if(root.nodeType!==1)return;const owner=root.closest('[data-item],[data-context]');if(owner)update(owner);for(const node of root.querySelectorAll('[data-item],[data-context]'))update(node);}
 scan(document.documentElement);new MutationObserver(changes=>{for(const change of changes)for(const node of change.addedNodes)scan(node);}).observe(document.documentElement,{subtree:true,childList:true});
}
function repairedReportLinks(html){
 const needsPosts=!html.includes('data-post-link-version="'+POST_LINK_VERSION+'"')||!html.includes(core.CONVERSATION_HEADING_STYLE),needsContent=!html.includes('data-content-link-version="'+CONTENT_LINK_VERSION+'"'),mayNeedPictures=!html.includes('data-comment-picture-version="'+core.COMMENT_PICTURE_VERSION+'"');
 if(!needsPosts&&!needsContent&&!mayNeedPictures)return null;
 if(!/<body\b/i.test(html))return null;
 const payload=html.match(/<script\b[^>]*id="weibo-report-records"[^>]*>([\s\S]*?)<\/script>/),authors={};
 let needsPictures=false;if(payload){let value;try{value=JSON.parse(payload[1]);}catch{return null;}if(!Array.isArray(value.rows))return null;const rows=[...value.rows,...(value.context||[])];if(needsPosts)Object.assign(authors,links.authorIndex(rows));needsPictures=mayNeedPictures&&rows.some(row=>core.commentBodyHtml(row).includes('data-comment-pictures'));}
 else if(!html.includes('id="posts"')||!html.includes('data-post'))return null;
 if(!needsPosts&&!needsContent&&!needsPictures)return null;
 const replaceContentCompat=needsContent||needsPictures&&html.includes('data-content-link-compat=');
 const replace=chunk=>{
  if(needsContent)chunk=chunk.replace(/<a class="content-link"[^>]*>([^<]*)<\/a>/g,(_,raw)=>core.linkedText(unescapeEntities(raw)));
  if(!needsPosts)return chunk;
  chunk=chunk.replace(/<p><span class="account-color-legend">[^<]*<\/span>[^<]*<\/p>/g,'');
  return chunk.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi,(all,attrs,label)=>{
   if(/\bdata-post-site=/.test(attrs)||/\bclass=(['"])[^'"]*\bcontent-link\b[^'"]*\1/.test(attrs))return all;
   const href=attrs.match(/\bhref=(['"])([^'"<>]+)\1/);if(!href)return all;
   const old=unescapeEntities(href[2]);if(!links.displayPostUrl(old))return all;
   const id=links.parsePostTarget(old),url=new URL(old),uid=payload?authors[id]||'':(/^(?:www\.)?weibo\.cn$/.test(url.hostname)?url.searchParams.get('uid')||'':'');
   return core.postLink(id,unescapeEntities(label.replace(/<[^>]*>/g,'')).replace(/\s*↗\s*$/,''),uid);
  });
 };
 let after=html.split(/(<script\b[^>]*>[\s\S]*?<\/script>)/gi).map(chunk=>{
  if(!/^<script\b/i.test(chunk))return replace(chunk);
  const tag=chunk.slice(0,chunk.indexOf('>'));
  if(needsPosts&&/\bdata-post-link-compat=/.test(tag)||replaceContentCompat&&/\bdata-content-link-compat=/.test(tag)||needsPictures&&/\bdata-comment-picture-compat=/.test(tag))return '';
  if(!/\bdata-lazy-thread\b/.test(tag))return chunk;
  const match=chunk.match(/^(<script\b[^>]*>)([\s\S]*?)(<\/script>)$/i);try{const data=JSON.parse(match[2]);function walk(v){if(typeof v==='string')return replace(v);if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));return v;}return match[1]+require('../lib/report-records').jsonPayload(walk(data))+match[3];}catch{return chunk;}
 }).join('');
 const script='<style>'+core.POST_LINKS_STYLE+core.CONVERSATION_HEADING_STYLE+'</style><script data-post-link-compat="'+POST_LINK_VERSION+'">(function(){const {postUrls,parsePostTarget}=('+links.createPostLinks.toString()+')();const text='+core.text.toString()+';const esc='+esc.toString()+';const postLink='+core.postLink.toString()+';('+upgradePostLinks.toString()+')('+links.createPostLinks.toString()+',postLink,'+JSON.stringify(authors)+','+!!payload+');})();</script>';
 const content=replaceContentCompat?'<style>.content-link{margin-inline:.15em}</style><script data-content-link-compat="'+CONTENT_LINK_VERSION+'">(function(){const text='+core.text.toString()+';const esc='+esc.toString()+';const displayPostUrl=('+links.createPostLinks.toString()+')().displayPostUrl;const linkedText='+core.linkedText.toString()+';('+upgradeContentLinks.toString()+')(linkedText);})();</script>':'';
 const pictures=needsPictures?'<style>'+core.COMMENT_PICTURES_STYLE+'</style><script data-comment-picture-compat="'+core.COMMENT_PICTURE_VERSION+'">(function(){const {commentUrl,displayPostUrl}=('+links.createPostLinks.toString()+')();'+['text','num','positiveId','esc','unescapeEntities','pictureUrl','commentPictureViewer','commentShortUrl','commentMediaEntries','commentMediaUrls','replyPrefixParts','readingText','linkedText','copyButton','commentBodyHtml'].map(k=>'const '+k+'='+core[k].toString()+';').join('')+'('+upgradeCommentPictures.toString()+')(commentBodyHtml);})();</script>':'';
 if(needsPosts)after=after.replace(/<body\b[^>]*>/i,body=>body.replace(/\sdata-post-link-version="[^"]*"/g,'').replace(/<body\b/i,'<body data-post-link-version="'+POST_LINK_VERSION+'"'));
 if(needsContent)after=after.replace(/<body\b[^>]*>/i,body=>body.replace(/\sdata-content-link-version="[^"]*"/g,'').replace(/<body\b/i,'<body data-content-link-version="'+CONTENT_LINK_VERSION+'"'));
 if(needsPictures)after=after.replace(/<body\b[^>]*>/i,body=>body.replace(/\sdata-comment-picture-version="[^"]*"/g,'').replace(/<body\b/i,'<body data-comment-picture-version="'+core.COMMENT_PICTURE_VERSION+'"'));
 after=after.replace(/<\/body>/i,(needsPosts?script:'')+content+pictures+'</body>');return after===html?null:after;
}
function repairedPostAuthor(html,entry){
 // Before the report header gained its own wrapper, the shared report used
 // the typed post ID in the generated author profile link.
 const postId=entry?.postId||entry?.uid;
 if(entry?.mode!=='post-comments'||typeof postId!=='string'||!/^[1-9]\d{4,19}$/.test(postId)||entry.uid&&entry.uid!==postId||!html.includes('href="https://weibo.cn/u/'+postId+'"'))return null;
 const tree=require('parse5').parse(html,{sourceCodeLocationInfo:true}),body=tree.childNodes.find(node=>node.tagName==='html')?.childNodes.find(node=>node.tagName==='body');
 const attr=(node,name)=>node?.attrs?.find(a=>a.name===name)?.value;
 if(attr(body,'data-color-mode')!=='posts'||attr(body,'data-target-uid')!==postId)return null;
 const mains=body.childNodes.filter(node=>node.tagName==='main');if(mains.length!==1)return null;
 const subtitles=mains[0].childNodes.filter(node=>node.tagName==='p'&&attr(node,'class')==='subtitle');
 if(subtitles.length!==1)return null;
 const {childNodes:nodes}=subtitles[0];
 if(nodes[0]?.nodeName!=='#text'||nodes[0].value!=='目标微博：'||attr(nodes[1],'class')!=='post-link-pair'||attr(nodes[1],'data-source-post-id')!==postId)return null;
 const anchors=nodes.filter((node,index)=>node.tagName==='a'&&attr(node,'class')==='user-link'&&attr(node,'data-user-id')===postId&&nodes[index-1]?.value===' · 原作者：');
 if(anchors.length!==1)return null;
 const [anchor]=anchors,loc=anchor.sourceCodeLocation,label=anchor.childNodes;
 if(!loc?.endTag||label.length!==1||label[0].nodeName!=='#text')return null;
 const original=html.slice(loc.startOffset,loc.endOffset);
 if(original!==core.userLink(label[0].value,postId))return null;
 const formal=require('../lib/report-records').locateReportPayload(html,tree);
 let payload;try{if(formal&&!formal.invalid)payload=JSON.parse(formal.text);}catch{/* An unreadable payload does not identify an author. */}
 const exact=row=>row?.group==='post-comments'&&row.postId===postId;
 const rows=payload?.uid===postId&&Array.isArray(payload.rows)?payload.rows.filter(row=>exact(row)&&!row.isContext):[];
 const context=Array.isArray(payload?.context)?payload.context.filter(exact):[];
 const {uid,nickname}=links.savedPostAuthor(rows.length?[...rows,...context]:[],postId);
 const replacement=uid?core.userLink(nickname,uid):'<span>未确认</span>';
 return replacement===original?null:html.slice(0,loc.startOffset)+replacement+html.slice(loc.endOffset);
}
function repairedLinks(html,entry){
 const other=repairedReportLinks(html);
 return repairedPostAuthor(other||html,entry)||other;
}
module.exports={repairedLinks};
