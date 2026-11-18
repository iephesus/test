'use strict';
// Repair the known portable reader defect without changing the saved selection,
// record payload or read state. User-edited reports are left untouched.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const regular=require('../lib/regular-file');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// A repaired old report can still own its original table markup and template.
function readerRuntime(html,run){
 const source=run.toString(),payload=html.search(/<script\b[^>]*\bid="weibo-report-records"[^>]*>/),shell=payload<0?html:html.slice(0,payload);
 if(!shell.includes('data-view-button="table"')||!shell.includes('id="table"'))return source;
 return source.replace('const renderers={timeline:timelineHtml};',`const renderers={timeline:timelineHtml};
 if(typeof tableHtml==='function'&&document.getElementById('table'))renderers.table=tableHtml;`);
}

function repairedMentionHeadings(html){
 if(html.includes('data-mention-body-version="3"'))return null;
 const payload=html.match(/<script\b[^>]*id="weibo-report-records"[^>]*>([\s\S]*?)<\/script>/);
 if(!payload||!/"group"\s*:\s*"mentions-posts"/.test(payload[1]))return null;
 let rows;try{rows=JSON.parse(payload[1]).rows;}catch{return null;}if(!Array.isArray(rows))return null;
 const grouped=new Map(),reader=require('../lib/reader');
 rows.forEach((row,i)=>{if(!row?.isContext&&typeof row?.postId==='string'){if(!grouped.has(row.postId))grouped.set(row.postId,[]);grouped.get(row.postId).push({row,i});}});
 const cards=new Map();for(const [id,items]of grouped){const {row,i}=items[0];if(items.length===1&&row.group==='mentions-posts'&&row.recordId===id&&/^[1-9]\d*$/.test(id)&&typeof row.content==='string')cards.set(id,reader.mentionedPostCard(row,i));}
 if(!cards.size)return null;
 // Match generated outer groups while respecting nested per-record details.
 // Saved body text and lazy JSON escape '<', so only structural tags occur here.
 const opening=/<details\b[^>]*\bdata-post-group\b[^>]*\bdata-post-id="(\d+)"[^>]*>/g,tags=/<\/?details\b[^>]*>/g,parts=[];let cursor=0,match;
 while((match=opening.exec(html))){if(!cards.has(match[1]))continue;tags.lastIndex=opening.lastIndex;let depth=1,tag;while((tag=tags.exec(html))){depth+=/^<\//.test(tag[0])?-1:1;if(!depth)break;}if(depth)return null;parts.push(html.slice(cursor,match.index),cards.get(match[1]));cursor=tags.lastIndex;opening.lastIndex=cursor;}
 if(!parts.length)return null;
 let after=parts.join('')+html.slice(cursor);
 after=after.replace(/const startPagedReader=function startPagedReader\(payload\)\{[\s\S]*?\n\};/,'const startPagedReader='+readerRuntime(html,require('../lib/reader-paged').startPagedReader)+';');
 if(rows.length&&rows.every(r=>r?.group==='mentions-posts'))after=after.replace('<div class="dialog-tools">','<div class="dialog-tools" hidden>').replace(/(<button\b[^>]*data-view-button="conversation"[^>]*>)[^<]*(<\/button>)/,'$1微博卡片$2');
 return after.replace(/<body\b[^>]*>/i,tag=>tag.replace(/\sdata-mention-body-version="[^"]*"/g,'').replace(/<body\b/i,'<body data-mention-body-version="3"')).replace(/<\/body>/i,'<style data-mention-body-style="3">'+reader.MENTION_BODY_STYLE+'</style></body>');
}
function repairedHtml(html){
 const pattern=/\(function startReader\(\)\{[\s\S]*?\n\}\)\(\);/;
 const match=pattern.exec(html);
 if(!match||!html.includes('id="weibo-report-records"'))return null;
 const legacy=match[0].includes("messages:[...body.children].filter(el=>el.matches('[data-item],[data-context]'))");
 const splitUnlinked=html.includes('data-reader-version="2"')&&!html.includes('data-conversation-layout-version="1"')&&match[0].includes('const key=message.dataset.branch;');
 if(!legacy&&!splitUnlinked)return null;
 const helper=html.includes('function layoutConversation(')?'':require('../lib/reader-layout').layoutConversation.toString()+'\n';
 let repaired=html.slice(0,match.index)+helper+'('+readerRuntime(html,require('../lib/reader-runtime').startReader)+')();'+html.slice(match.index+match[0].length);
 const paged=/const startPagedReader=function startPagedReader\(payload\)\{[\s\S]*?\n\};/;
 repaired=repaired.replace(paged,'const startPagedReader='+readerRuntime(html,require('../lib/reader-paged').startPagedReader)+';');
 repaired=repaired.replace('data-reader-version="2"','data-reader-version="2" data-conversation-layout-version="1"');
 repaired=repaired.replace(/const detailsFor=function publicDetails\(r,compact=false\)\{[^\n]+\};/,'const detailsFor='+require('../lib/share-report').publicDetails.toString()+';');
 // The original reply prefix remains in the payload. Expose its recipient in
 // details without assigning a UID, parent ID, or changing saved selection.
 repaired=repaired.replace("r.replyAuthor||r.displayReplyAuthor,r.replyAuthorUid", "r.replyAuthor||r.displayReplyAuthor||replyPrefixParts(r.content)?.name,r.replyAuthorUid");
 return repaired;
}
function repairedPaging(html){
 const pattern=/const startPagedReader=function startPagedReader\(payload\)\{[\s\S]*?\n\};/,previous=pattern.exec(html);
 if(!previous||!html.includes('class="thread-body"'))return null;
 // Current readers only need repair if they contain the earlier jump logic.
 const wholeFloors=html.includes('data-conversation-window-version="1"');
 if(wholeFloors&&!previous[0].includes('const selectedIds=new Set(matching),selected=groups.filter(g=>g.ids.some(i=>selectedIds.has(i)))'))return null;
 const payload=html.match(/<script\b[^>]*id="weibo-report-records"[^>]*>([\s\S]*?)<\/script>/);if(!payload)return null;
 try{const value=JSON.parse(payload[1]);if(!value.paged&&!(value.rows?.length>200))return null;}catch{return null;}
 // Version-1 readers can already keep whole floors but still compute jumps
 // without quote-only matching floors. Replace only that known runtime.
 if(wholeFloors)return html.replace(pattern,'const startPagedReader='+readerRuntime(html,require('../lib/reader-paged').startPagedReader)+';');
 const reader=require('../lib/reader-paged'),runtime=/\(function startReader\(\)\{[\s\S]*?\n\}\)\(\);/;let after=html.replace(pattern,'const startPagedReader='+readerRuntime(html,reader.startPagedReader)+';').replace(runtime,'('+readerRuntime(html,require('../lib/reader-runtime').startReader)+')();');
 if(!after.includes('function layoutConversation('))after=after.replace('const startPagedReader=',require('../lib/reader-layout').layoutConversation.toString()+'\nconst startPagedReader=');
 return after.replace(/<body\b/i,'<body data-conversation-window-version="1"').replace(/<\/body>/i,'<style data-conversation-window-style="1">'+reader.FLOW_STYLE+'</style></body>');
}
function repairedUnreadNavigation(html){
 // Only this known generated helper is eligible. The outer repair still
 // requires the catalog's exact HTML hash before touching a managed report.
 const old="function focusUnreadRecord(target){if(!target)return;for(const previous of document.querySelectorAll('.unread-record-focus'))previous.classList.remove('unread-record-focus');target.classList.add('unread-record-focus');target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'center',behavior:'smooth'});}";
 if(!html.includes('id="weibo-report-records"')||!html.includes('function focusUnreadRecord(target)'))return null;
 const firstCalibration='const pending=new AbortController();focusUnreadRecord.pending=pending;';
 if(!html.includes(old)&&!(html.includes(firstCalibration)&&html.includes('stable<4')))return null;
 let changed=false;
 const after=html.replace(/(<script\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)(<\/script\s*>)/gi,(whole,opening,body,closing)=>{
  const calibrated=/function focusUnreadRecord\(target\)\{\n[\s\S]*?\n\}/.exec(body)?.[0],previous=body.includes(old)?old:calibrated?.includes(firstCalibration)&&calibrated.includes('stable<4')?calibrated:null;
  if(!previous)return whole;
  // Parse only the small opening tag, never the potentially large data body.
  // Attribute order, quotes and a data-* value containing "type=" must not
  // turn an inert JSON/text payload into an eligible executable script.
  const node=require('parse5').parseFragment(opening+'</script>').childNodes[0],attrs=new Map((node?.attrs||[]).map(a=>[a.name,a.value])),type=(attrs.get('type')||'').trim().toLowerCase();
  if(node?.tagName!=='script'||attrs.has('src')||!['','text/javascript','application/javascript','text/ecmascript','application/ecmascript','module'].includes(type))return whole;
  const templates=require('../lib/reader-templates'),helpers=(body.includes('function beginUnreadNavigation(')?'':templates.beginUnreadNavigation.toString()+'\n')+templates.focusUnreadRecord.toString();
  const updated=body.replace(previous,()=>helpers).replace(/\(function startReader\(\)\{[\s\S]*?\n\}\)\(\);/,()=>'('+readerRuntime(html,require('../lib/reader-runtime').startReader)+')();').replace(/const startPagedReader=function startPagedReader\(payload\)\{[\s\S]*?\n\};/,()=>'const startPagedReader='+readerRuntime(html,require('../lib/reader-paged').startPagedReader)+';');
  changed=true;return opening+updated+closing;
 });
 return changed?after:null;
}
function repairedUnreadColors(html){
 const previousPair='.group-unread-badge.unread-sent{border-color:#d6e7da;background:#f2f8f3;color:#28764a}.group-unread-badge.unread-received{border-color:#d7e4f6;background:#eff5fd;color:#1f5fbf}';
 const priorRules=[previousPair,'.group-unread-badge.unread-received{border-color:#d6e7da;background:#f2f8f3;color:#28764a}','.group-unread-badge.unread-received{border-color:#c6e0ce;background:#eff8f1;color:#28764a}'];
 const headEnd=/<\/head\s*>/i.exec(html);
 if(!headEnd||!html.includes('id="weibo-report-records"'))return null;
 const source=html.slice(0,headEnd.index+headEnd[0].length),current=require('../lib/reader-visual').UNREAD_DIRECTION_STYLE;
 if(!priorRules.some(rule=>source.includes(rule)))return null;
 // Locate the actual head stylesheet without reserializing the HTML or parsing the record payload.
 const document=require('parse5').parse(source,{sourceCodeLocationInfo:true});
 const head=document.childNodes.find(node=>node.tagName==='html')?.childNodes.find(node=>node.tagName==='head');
 const candidates=[];
 for(const node of head?.childNodes||[]){
  const loc=node.sourceCodeLocation,type=node.attrs?.find(attr=>attr.name==='type')?.value.trim().toLowerCase()||'';
  if(node.tagName!=='style'||!loc?.endTag||!['','text/css'].includes(type))continue;
  const start=loc.startTag.endOffset,body=source.slice(start,loc.endTag.startOffset);
  if(!body.includes('.group-unread-badge{')||body.includes(current))continue;
  const rule=priorRules.find(rule=>body.includes(rule));
  if(rule&&body.indexOf(rule)===body.lastIndexOf(rule))candidates.push({start:start+body.indexOf(rule),rule});
 }
 if(candidates.length!==1)return null;
 const {start,rule}=candidates[0];
 return html.slice(0,start)+current+html.slice(start+rule.length);
}
function repairedSelectControls(html){
 if(!html.includes('data-report-visual="')&&!html.includes('id="weibo-report-records"'))return null;
 let changed=false;
 // Only a known generated stylesheet is eligible. Raw-text data and comments
 // can contain literal style tags; they must remain byte-for-byte intact.
 const after=html.replace(/<!--[\s\S]*?-->|<(?:script|textarea|title|xmp|iframe|noembed|noframes)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/(?:script|textarea|title|xmp|iframe|noembed|noframes)\s*>|(<style\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)(<\/style\s*>)/gi,(whole,opening,body,closing)=>{
  if(!opening||body.includes('/* reader-select-controls-v1 */')||!body.includes(':root{--paper:#fff;--canvas:#f4f6fa;')||!body.includes('.toolbar select'))return whole;
  const node=require('parse5').parseFragment(opening+'</style>').childNodes[0],type=node?.attrs?.find(a=>a.name==='type')?.value.trim().toLowerCase()||'';
  if(node?.tagName!=='style'||!['','text/css'].includes(type))return whole;
  changed=true;return opening+body+require('../lib/reader-visual').SELECT_CONTROL_STYLE+closing;
 });
 return changed?after:null;
}
function repairedDetailSections(html){
 const old='.context-text{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}';
 if(!html.includes('id="weibo-report-records"')||!html.includes(old))return null;
 let changed=false;
 // Only the known generated stylesheet can receive these presentation rules.
 // Literal CSS in saved scripts, comments and raw-text elements stays intact.
 const after=html.replace(/<!--[\s\S]*?-->|<(?:script|textarea|title|xmp|iframe|noembed|noframes)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/(?:script|textarea|title|xmp|iframe|noembed|noframes)\s*>|(<style\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)(<\/style\s*>)/gi,(whole,opening,body,closing)=>{
  if(!opening||!body.includes(old)||body.includes('/* reader-detail-sections-v1 */')||!body.includes(':root{--paper:#fff;--canvas:#f4f6fa;')||!body.includes('.record-details-body{background:var(--soft);border:1px solid var(--line);'))return whole;
  const node=require('parse5').parseFragment(opening+'</style>').childNodes[0],type=node?.attrs?.find(a=>a.name==='type')?.value.trim().toLowerCase()||'';
  if(node?.tagName!=='style'||!['','text/css'].includes(type))return whole;
  changed=true;return opening+body+require('../lib/reader-visual').DETAIL_SECTIONS_STYLE+closing;
 });
 return changed?after:null;
}
function repairedDialogOrder(html){
 const shell='<div id="conversation" class="view" role="tabpanel" data-view="conversation" data-dialog-order="time">';
 const controls='<button type="button" data-dialog-order="branches" aria-pressed="false">按分支</button><button type="button" data-dialog-order="time" aria-pressed="true">时间顺序</button>';
 if(!html.includes(shell)||!html.includes(controls))return null;
 // The generated record payload escapes '<'. Limit edits to the report shell
 // before that payload and its immediately following executable reader script.
 const reader=/<script type="application\/json" id="weibo-report-records">[^<]*<\/script>\s*<script>\(\(\)=>\{\n([\s\S]*?)<\/script>/;
 const match=reader.exec(html);
 if(!match||!match[1].includes('const startPagedReader=function startPagedReader(payload){')||!match[1].includes('(function startReader(){'))return null;
 const before=html.slice(0,match.index);
 if(!before.includes(shell)||!before.includes(controls))return null;
 const runtime=match[1].replace("let view='conversation',order='time',page=0","let view='conversation',order='branches',page=0")
  .replaceAll("dialogOrder||'time'","dialogOrder||'branches'").replace("\n setOrder('time');","\n setOrder('branches');");
 if(!runtime.includes("let view='conversation',order='branches',page=0")||!runtime.includes("\n setOrder('branches');"))return null;
 return before.replace(shell,shell.replace('"time"','"branches"'))
  .replace(controls,controls.replace('"branches" aria-pressed="false"','"branches" aria-pressed="true"').replace('"time" aria-pressed="true"','"time" aria-pressed="false"'))
  +match[0].replace(match[1],()=>runtime)+html.slice(match.index+match[0].length);
}
function repairedCommentOrder(html,postId,dir){
 if(html.includes('data-comment-order="1"')||!html.includes('data-color-mode="posts"'))return null;
 const marker=/<script type="application\/json" id="weibo-report-records">([^<]*)<\/script>\s*(?=<script>\(\(\)=>\{\n)/.exec(html);
 if(!marker)return null;
 let payload;try{payload=JSON.parse(marker[1]);}catch{return null;}
 if(!Array.isArray(payload.rows))return null;
 const rows=payload.rows.filter(row=>row.group==='post-comments'&&row.postId===postId&&!row.isContext);
 if(!rows.length)return null;
 const order=require('../lib/comment-order'),rank=order.savedRanks(dir,postId,rows);
 if(!Object.keys(rank).length)return null;
 const at=marker.index+marker[0].length,args=require('../lib/report-records').jsonPayload([postId,rank]);
 return html.slice(0,at)+'<script data-comment-order="1">('+order.applySavedOrder.toString()+')(...'+args+');</script>'+html.slice(at);
}
function prepareReportReader(base,id,file){
 const catalog=require('../lib/report-catalog'),meta=catalog.metadata(base);id=catalog.normalizeId(id);const entry=catalog.entryOf(meta.entries,id);
 if(!/^[a-f0-9]{64}$/.test(entry?.localHash||''))return {entry,repaired:false};
 const before=regular.read(file),digest=hash(before),snapshot={entry,bytes:before,digest,repaired:false};
 const root=require('../lib/data-layout').readerRoot(base);
 const catalogFile=path.join(root,'report-catalog.json'),journal=path.join(root,'reader-repairs',entry.localHash+'.json');
 const {atomic}=require('../lib/auto-follow-budget');
 if(entry.localHash!==digest){
  // Recover the interruption window between atomic HTML and catalog commits.
  let saved;try{saved=JSON.parse(regular.read(journal));}catch{return snapshot;}
  if(catalog.normalizeId(saved.id)!==id||saved.beforeHash!==entry.localHash||saved.afterHash!==digest)return snapshot;
  entry.localHash=digest;atomic(catalogFile,meta);
  return {...snapshot,repaired:true};
 }
 const source=before.toString('utf8');
 let colorEntry=entry,postDir;
 if(entry.mode==='post-comments'&&/^[1-9]\d{4,19}$/.test(entry.postId||'')&&
    (!source.includes('data-account-colors="'+require('../lib/reader-colors').VERSION+'"')||!source.includes('data-comment-order="1"'))){
  try{
   const storage=require('../lib/storage');
   postDir=storage.findPostFolder(storage.storagePaths(base).postComments,entry.postId);
   if(fs.existsSync(postDir)&&!source.includes('data-account-colors="'+require('../lib/reader-colors').VERSION+'"'))
    colorEntry={...entry,postAuthors:require('../lib/post-display-index').create(postDir,entry.postId).authors()};
  }catch{/* Inaccessible source evidence must not block opening the old report. */}
 }
 const transforms=[repairedHtml,repairedMentionHeadings,repairedPaging,
  html=>require('./report-link-repair').repairedLinks(html,entry),
  repairedUnreadNavigation,require('../lib/reader-mobile').repair,
  html=>require('../lib/reader-colors').repair(html,colorEntry),
  repairedUnreadColors,repairedSelectControls,repairedDetailSections,repairedDialogOrder,
  html=>postDir&&repairedCommentOrder(html,entry.postId,postDir)];
 let html=source;
 for(const transform of transforms)html=transform(html)??html;
 if(html===source)return snapshot;
 const after=Buffer.from(html),afterHash=hash(after),backup=path.join(root,'reader-repairs',digest+'.html');
 fs.mkdirSync(path.dirname(backup),{recursive:true});if(!fs.existsSync(backup))fs.writeFileSync(backup,before,{flag:'wx',mode:0o600});
 // Write the repaired copy atomically; retain the original generation timestamp.
 const stat=fs.statSync(file);
 atomic(journal,{schema:1,id,beforeHash:digest,afterHash});
 require('../lib/incremental').atomicText(file,html);fs.utimesSync(file,stat.atime,stat.mtime);
 entry.localHash=afterHash;atomic(catalogFile,meta);
 return {entry,bytes:after,digest:afterHash,repaired:true};
}
function repairReportReader(base,id,file){return prepareReportReader(base,id,file).repaired;}
module.exports={repairedHtml,repairedMentionHeadings,repairedPaging,repairedUnreadNavigation,repairedUnreadColors,repairedSelectControls,repairedDetailSections,repairedDialogOrder,repairReportReader,prepareReportReader};
