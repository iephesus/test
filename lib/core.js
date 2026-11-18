'use strict';
const {MODES,ENDPOINTS,BASE}=require('./config');
const {runCli,preflight}=require('./api');
const {parsePostTarget,postShortId,commentUrl,postUrl,postUrls,displayPostUrl,confirmedAuthor}=require('./post-links');
const {CONVERSATION_HEADING_STYLE,accountColors,ACCOUNT_COLOR_STYLE,ACCOUNT_COLOR_SCRIPT,READING_STYLE,COPY_STYLE,COPY_SCRIPT}=require('./reader-assets');
const text=v=>v==null?'':String(v);
// JSON numbers beyond the safe-integer range have already lost their original
// digits. Only a returned exact string can recover that identity.
const num=v=>((typeof v==='number'&&Number.isSafeInteger(v))||typeof v==='string'||typeof v==='bigint')&&/^\d+$/.test(String(v))?String(v):'';
const positiveId=(...values)=>{
 const ids=values.map(num),positive=id=>id&&/[1-9]/.test(id);
 if(values.some(v=>typeof v==='number'&&!Number.isSafeInteger(v))&&!values.some((v,i)=>typeof v==='string'&&positive(ids[i])))return '';
 let selected='',canonical='';for(const id of ids){if(!positive(id))continue;const exact=id[0]==='0'?BigInt(id).toString():id;if(canonical&&canonical!==exact)return '';canonical=exact;if(!selected)selected=id;}
 return selected;
};
function reliableId(label,...values){
 const id=positiveId(...values);
 if(!id&&values.some(v=>v!=null&&v!==''&&v!==0&&v!=='0'))throw Object.assign(Error(label+' 无法无损识别'),{code:'RECORD_ID_UNRELIABLE'});
 return id;
}
const userId=u=>positiveId(u?.idstr,u?.id,u?.uid);
const userName=u=>text(u?.screen_name??u?.name??u?.nickname).trim();
const CONTENT_LINK_VERSION='2';
const COMMENT_PICTURE_VERSION='8';
const COMMENT_PICTURES_STYLE='.comment-picture-links{display:inline-flex;flex-wrap:wrap;gap:4px 10px;vertical-align:baseline;max-width:100%;min-width:0}.comment-picture-link{display:inline-block;white-space:normal;max-width:100%;min-width:0;overflow-wrap:anywhere}.comment-picture-unavailable{font-size:12px;color:#718199}';
// Link only HTTP(S) text. Never treat source text as HTML or an executable URL.
function linkedText(value){
 // Known short/profile/post routes have ASCII identifiers. Prose immediately
 // following those identifiers is not part of the URL. Other paths and URL
 // queries still allow Unicode; visible CJK sentence punctuation is a delimiter.
 const input=text(value),pattern=/https?:\/\/t\.cn\/[a-z0-9]+(?=[^\x00-\x7f]|[,;])|https?:\/\/(?:(?:www\.)?weibo\.(?:com|cn)|m\.weibo\.cn)\/(?:(?:u|profile)\/\d+|(?:detail|status|comment)\/[a-z0-9]+|\d+\/[a-z0-9]+)(?=[^\x00-\x7f]|[,;])|https?:\/\/[^\s<>"'`\\\u0000-\u001f\u007f\[\]{}，。！？；：、…（）【】《》「」『』]+/giu;let out='',at=0;
 for(const match of input.matchAll(pattern)){
  let url=match[0].replace(/[.,!?;:，。！？；：、…）】》」』]+$/gu,'');
  while(url.endsWith(')')&&(url.match(/\)/g)||[]).length>(url.match(/\(/g)||[]).length)url=url.slice(0,-1);
  let safe=false;try{const parsed=new URL(url);safe=['http:','https:'].includes(parsed.protocol)&&!!parsed.hostname;}catch{}
  out+=esc(input.slice(at,match.index));out+=safe?'<a class="content-link" href="'+esc(displayPostUrl(url)||url)+'" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">'+esc(url)+'</a>':esc(url);out+=esc(match[0].slice(url.length));at=match.index+match[0].length;
 }
 return out+esc(input.slice(at));
}
function hasBefore(o){return Number.isFinite(o.beforeMs);}
function parseBefore(value){
 const match=text(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
 const invalid=()=>Error('--before 日期无效，只需 YYYY-MM-DD，例如 --before 2026-10-25（包含所选当天）');
 if(!match)throw invalid();
 const [,year,month,day]=match;
 const date=new Date(0);date.setUTCFullYear(Number(year),Number(month)-1,Number(day));
 if(Number(year)<1000||date.getUTCFullYear()!==Number(year)||date.getUTCMonth()!==Number(month)-1||date.getUTCDate()!==Number(day))throw invalid();
 return Date.parse(`${year}-${month}-${day}T00:00:00+08:00`)+86400000-1;
}
function beforeDisplay(o){
 if(!hasBefore(o))return '';
 return require('./date-range').dayOf(o.beforeMs);
}
function historySuffix(o){return hasBefore(o)?'_截至'+beforeDisplay(o).replace(/[- :]/g,''):'';}
function plan(o){
 // A mixed timeline can contain only outgoing comments when those dominate
 // the newest records. Query the two directions separately to guarantee
 // each direction receives a quota. Combined quota is still only o.count.
 if(o.mode==='both'||o.mode==='all'){
   const sent=Math.ceil(o.count/2),received=Math.floor(o.count/2);
   const parts=[{kind:'sent',budget:sent,output:'both'},
                {kind:'received',budget:received,output:'both'}];
   if(o.mode==='all')parts.push(
     {kind:'mentions-comments',budget:o.count,output:'mentions-comments'},
     {kind:'mentions-posts',budget:o.count,output:'mentions-posts'}
   );
   return parts;
 }
 return [{kind:o.mode,budget:o.count,output:o.mode}];
}
function unescapeEntities(s){const map={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…'};
 return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|hellip);/gi, (m,x)=>{
  if(x[0]!=='#')return map[x.toLowerCase()]??m;
  const v=x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):parseInt(x.slice(1),10);
  return v>0&&v<=0x10FFFF?String.fromCodePoint(v):m;
 });}
function cleanText(v){return unescapeEntities(text(v).replace(/<img\b[^>]*\balt=(?:"([^"]*)"|'([^']*)')[^>]*>/gi,(_m,a,b)=>a??b??'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/p\s*>/gi,'\n').replace(/<[^>]*>/g,''));}
function esc(v){return text(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

// Use only returned picture addresses; IDs alone never become guessed CDN URLs.
function pictureUrl(value){
 if(typeof value!=='string')return '';
 let address=unescapeEntities(value.trim());if(address.startsWith('//'))address='https:'+address;
 try{
  const url=new URL(address);
  if(!['https:','http:'].includes(url.protocol)||!url.hostname||url.username||url.password)return '';
  // The image CDN rejects legacy HTTP links with ACCESS DENIED; retain the exact image path.
  if(url.protocol==='http:'&&/(^|\.)sinaimg\.(cn|com)$/i.test(url.hostname))url.protocol='https:';
  return url.href;
 }catch{return '';}
}
// A comment viewer has its own returned object address. A CDN filename, post ID
// or comment ID cannot supply that opaque object ID.
function commentPictureViewer(value){
 const address=pictureUrl(value);if(!address)return '';
 const u=new URL(address);
 if(u.hostname!=='photo.weibo.com'||u.port||!/^\/h5\/comment\/compic_id\/1022:(?:230597(?:[a-f\d]{32}|6[A-Za-z\d]{16,64})|232975[1-9]\d{4,19})\/?$/.test(u.pathname))return '';
 u.protocol='https:';return u.href;
}
function commentShortUrl(value){
 try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&u.hostname==='t.cn'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/[A-Za-z\d]{4,32}$/.test(u.pathname)?u.href:'';}catch{return '';}
}
function commentMediaEntries(r){
 const exact=v=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):'';
 const m=r.commentMedia,id=exact(r.recordId);if(!m||m.schema!==1||!id||exact(m.commentId)!==id)return [];
 for(const k of ['postId','authorUid'])if(m[k]&&(!exact(m[k])||r[k]&&exact(m[k])!==exact(r[k])))return [];
 const entries=new Map();
 for(const item of (Array.isArray(m.items)?m.items:[]).slice(0,64)){
  const url=commentPictureViewer(item?.url)||commentShortUrl(item?.url);if(!url)continue;
  const shortUrl=commentShortUrl(item.shortUrl)||commentShortUrl(url),old=entries.get(url);
  if(!old||!old.shortUrl&&shortUrl)entries.set(url,{url,shortUrl,pictureIds:(Array.isArray(item.pictureIds)?item.pictureIds:[]).filter(v=>typeof v==='string'&&/^[A-Za-z\d_-]{8,100}$/.test(v))});
 }
 return [...entries.values()];
}
function commentMediaUrls(r){
 return commentMediaEntries(r).map(item=>item.url);
}
function pictureId(value){return typeof value==='string'&&/^[a-z\d_-]+$/i.test(value)?value:'';}
function pictureIdFromUrl(value){
 try{const url=new URL(value);return /(^|\.)sinaimg\.(cn|com)$/i.test(url.hostname)?pictureId(url.pathname.split('/').pop().replace(/\.[a-z\d]+$/i,'')):'';}catch{return '';}
}
function mergePostPictures(...sources){
 const ids=[],items=[],idOrder=new Map(),byId=new Map(),byUrl=new Map();let total=0;
 // URL updates can leave several current entries with one URL. A lazy min heap
 // preserves the original first-match rule without rescanning all earlier pictures.
 function push(url,index){let heap=byUrl.get(url);if(!heap)byUrl.set(url,heap=[]);let at=heap.length;heap.push(index);while(at){const p=(at-1)>>1;if(heap[p]<=index)break;heap[at]=heap[p];at=p;}heap[at]=index;}
 function first(url){const heap=byUrl.get(url);if(!heap)return Infinity;while(heap.length&&items[heap[0]].url!==url){const last=heap.pop();if(!heap.length)break;let at=0;while(at*2+1<heap.length){let child=at*2+1;if(child+1<heap.length&&heap[child+1]<heap[child])child++;if(heap[child]>=last)break;heap[at]=heap[child];at=child;}heap[at]=last;}return heap.length?heap[0]:Infinity;}
 function bind(id,index){if(id&&(!byId.has(id)||byId.get(id)>index))byId.set(id,index);}
 for(const source of sources){
  if(!source)continue;
  for(const value of source.ids||[]){const id=pictureId(value);if(id&&!idOrder.has(id)){idOrder.set(id,ids.length);ids.push(id);}}
  if(Number.isSafeInteger(source.total)&&source.total>total)total=source.total;
  for(const item of source.items||[]){
   const url=pictureUrl(item.url);if(!url)continue;
   const id=pictureId(item.id)||pictureIdFromUrl(url),rank=Number(item.rank)||0;
   const index=Math.min(id&&byId.has(id)?byId.get(id):Infinity,first(url)),existing=items[index];
   if(!existing){const index=items.length;items.push({id,url,rank});bind(id,index);push(url,index);}
   else{if(!existing.id){existing.id=id;bind(id,index);}if(rank>existing.rank||rank===existing.rank&&url.localeCompare(existing.url)<0){if(existing.url!==url)push(url,index);existing.url=url;existing.rank=rank;}}
  }
 }
 const order=id=>idOrder.get(id)??Infinity;
 items.sort((a,b)=>order(a.id)-order(b.id));
 return {ids,items,total:Math.max(total,ids.length,items.length)};
}
function postPictures(status){
 const s=status&&typeof status==='object'?status:{};
 const result={ids:Array.isArray(s.pic_ids)?s.pic_ids:[],items:[],total:Number(s.pic_num)||0};
 function add(value,id=''){
  const p=typeof value==='string'?{url:value}:value;if(!p||typeof p!=='object')return;
  const candidates=[p.original_pic,p.original?.url,p.largest?.url,p.large?.url,p.bmiddle_pic,p.bmiddle?.url,p.url,p.thumbnail_pic,p.thumbnail?.url];
  for(let i=0;i<candidates.length;i++){
   const url=pictureUrl(candidates[i]);if(!url)continue;
   result.items.push({id:pictureId(id)||pictureId(p.pid)||pictureId(p.pic_id)||pictureIdFromUrl(url),url,rank:candidates.length-i});return;
  }
 }
 for(const key of ['pic_urls','pics'])if(Array.isArray(s[key]))for(const pic of s[key])add(pic);
 if(s.pic_infos&&typeof s.pic_infos==='object')for(const [id,pic] of Object.entries(s.pic_infos))add(pic,id);
 if(Array.isArray(s.mix_media_info?.items))for(const media of s.mix_media_info.items)if(['pic','image','photo'].includes(media.type))add(media.data);
 add({original_pic:s.original_pic,bmiddle_pic:s.bmiddle_pic,thumbnail_pic:s.thumbnail_pic});
 return mergePostPictures(result);
}
function postPicturesHtml(pictures,postId){
 const p=mergePostPictures(pictures);if(!p.total)return '';
 const id=postShortId(postId);
 // Browser image requests need a Weibo origin. Let the official viewer supply it.
 const viewer=id?`https://weibo.cn/mblog/${p.total===1?'pic':'picAll'}/${id}`:'';
 const link=viewer?`<a class="post-picture-link" href="${esc(viewer)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="在微博图片页查看；未登录时需要先登录微博">查看图片${p.total>1?`（${p.total} 张）`:''} ↗</a>`:`<span class="post-picture-note">已知 ${p.total} 张，原微博 ID 未返回</span>`;
 return `<span class="post-pictures" data-post-pictures data-picture-count="${p.total}"><span class="source-label">图片：</span>${link}</span>`;
}
const POST_PICTURES_STYLE='.post-pictures{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 12px;font-size:12px;line-height:1.8}.post-picture-link{white-space:nowrap;font-weight:500}.post-picture-note{color:#718199;font-size:11px}';

function rawArray(raw,kind){
 if(Array.isArray(raw))return {items:raw,container:{}};
 const candidates=[raw,raw?.data,raw?.result,raw?.response,raw?.data?.data];
 const fields=['mentions-posts','user-posts'].includes(kind)?['statuses','items','list','data']:['comments','items','list','data'];
 for(const c of candidates){if(!c||typeof c!=='object')continue;for(const f of fields){if(Array.isArray(c[f]))return {items:c[f],container:c};}}
 return null;
}
const unsuccessfulOutcomes=new Set(['failed','error','denied','not_executed']);
function executionFailed(raw){return [raw,raw?.data].some(value=>typeof value?.outcome==='string'&&unsuccessfulOutcomes.has(value.outcome.trim().toLowerCase()));}
function unverifiedBilling(raw){return [raw,raw?.data].some(value=>value?.billing!=null||value?.outcome!=null);}
function apiError(raw){const e=raw?.error??raw?.data?.error;
 if(executionFailed(raw))return '服务端未确认请求成功执行，原始响应保留，未推进读取位置';
 if(raw?.success===false||raw?.data?.success===false||e)return text(e?.message??raw?.message??e??'未知服务端错误');
 return '';
}
const {formatTimestamp}=require('./date-range');
function ts(v){const value=text(v),explicit=/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?$/.test(value)?value.replace(' ','T')+'+08:00':value;const t=Date.parse(explicit);if(!Number.isFinite(t))return {ms:null,display:text(v)||'未知'};
 return {ms:t,display:formatTimestamp(t)};}
function mkComment(c,kind,uid){const s=c.status??c.weibo??{};const u=c.user??{};const t=ts(c.created_at??c.createdAt);
 const parent=c.reply_comment&&typeof c.reply_comment==='object'?c.reply_comment:{};
 const explicitReply=reliableId('回复评论 ID',c.reply_idstr,c.reply_id),parentId=reliableId('引用评论 ID',parent.idstr,parent.id,parent.mid);
 const replyId=explicitReply||parentId;
 const postId=reliableId('原微博 ID',s.idstr,s.id,s.mid,c.status_idstr,c.status_id,c.statusid),parentPost=parent.status??parent.weibo??{};
 const parentPostId=reliableId('引用原微博 ID',parentPost.idstr,parentPost.id,parentPost.mid,parent.status_idstr,parent.status_id,parent.statusid);
 // Do not attach a nested quote to a conflicting explicit reply ID.
 const parentMatches=(!replyId||!parentId||replyId===parentId)&&(!postId||!parentPostId||postId===parentPostId);
 const ownMedia=require('./comment-media').extract(c),parentMedia=parentMatches&&parentId?require('./comment-media').extract(parent):null;
 const recipient=(parentMatches?parent.user:null)??c.reply_user??{};
 const parentTime=ts(parent.created_at??parent.createdAt);
 const quoted=parentMatches&&parentId?{
   recordId:parentId,rootId:reliableId('引用根评论 ID',parent.rootidstr,parent.rootid),
   author:userName(parent.user)||'未知用户',authorUid:userId(parent.user),
   content:cleanText(require('./record-quality').commentText(parent)),...require('./record-quality').timeFields(parent.created_at??parent.createdAt,parentTime.display,parentTime.ms),pictures:postPictures(parent),...(parentMedia?{commentMedia:parentMedia}:{}),
   replyId:reliableId('引用回复评论 ID',parent.reply_idstr,parent.reply_id),
   replyAuthor:userName(parent.reply_user),replyAuthorUid:userId(parent.reply_user)
 }:null;
 let label=ENDPOINTS[kind]?.label??'评论';
 if(kind==='both'){
  const writer=userId(u)===uid;
  const owner=userId(s.user)===uid||userId(recipient)===uid;
  label=writer&&owner?'发出/收到':writer?'发出':owner?'收到':'双向评论（无法判定方向）';
 }
 return {type:label,group:kind,author:userName(u)||'未知用户',authorUid:userId(u),...require('./record-quality').timeFields(c.created_at??c.createdAt,t.display,t.ms),pictures:postPictures(c),...(ownMedia?{commentMedia:ownMedia}:{}),
  content:cleanText(require('./record-quality').commentText(c)),postId,
  postAuthor:userName(s.user),postAuthorUid:userId(s.user),postText:cleanText(s.text_raw??s.text??''),postPictures:postPictures(s),
  postTime:s.created_at||s.createdAt?ts(s.created_at??s.createdAt).display:'',
  recordId:reliableId('评论 ID',c.idstr,c.id,c.mid),rootId:reliableId('根评论 ID',c.rootidstr,c.rootid),replyId,
  replyAuthor:userName(recipient),replyAuthorUid:userId(recipient),
  replyText:parentMatches?cleanText(require('./record-quality').commentText(parent)):'',
  replyTime:parentMatches&&(parent.created_at??parent.createdAt)?parentTime.display:'',replyRecord:quoted,
  ...(c.like_counts!=null||c.like_count!=null?{likes:Number(c.like_counts??c.like_count)||0}:{})};
}
function mkPost(s){const u=s.user??{};const t=ts(s.created_at??s.createdAt);
 const id=reliableId('微博 ID',s.idstr,s.id,s.mid);
 return {type:'被@的微博',group:'mentions-posts',author:text(u.screen_name??u.name??'未知用户'),authorUid:userId(u),time:t.display,ms:t.ms,
  content:cleanText(s.text_raw??s.text??s.content??''),postId:id,postAuthor:userName(u),postAuthorUid:userId(u),postText:'',postTime:t.display,postPictures:postPictures(s),
  recordId:id,rootId:'',replyId:'',likes:Number(s.attitudes_count??0)||0};
}
function normalize(raw,kind,uid){return kind==='mentions-posts'?mkPost(raw):mkComment(raw,kind,uid);}
function recId(raw,kind){return positiveId(raw?.idstr,raw?.id,raw?.mid);}
function nameFromUser(u,uid){if(!u||typeof u!=='object'||userId(u)!==uid)return '';
 return text(u.screen_name??u.name??u.nickname).trim();}
function targetNickname(raw,kind,uid){
 for(const box of [raw,raw?.data,raw?.result,raw?.response]){const n=nameFromUser(box?.user,uid);if(n)return n;}
 const xs=rawArray(raw,kind)?.items??[];
 for(const c of xs){for(const u of [c.user,c.status?.user,c.weibo?.user,c.target_user,c.reply_user,c.reply_comment?.user]){const n=nameFromUser(u,uid);if(n)return n;}}
 return '';
}
function safeName(s){return [...text(s).normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g,'_').trim().replace(/[. ]+$/g,'')].slice(0,70).join('')||'';}
const POST_LINKS_STYLE='.post-link-pair{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;vertical-align:baseline}.post-link-pair .source-post-link{white-space:nowrap;margin:0}.post-link-label{white-space:nowrap;font-size:inherit}';
function postLink(id,label='',authorUid=''){
  const urls=postUrls(id,authorUid);if(!urls)return '—';const safe=parsePostTarget(id);
  return `<span class="post-link-pair" data-source-post-id="${safe}">${label===false?'':`<span class="post-link-label">${esc(label||safe)}</span>`}${['com','cn'].map(site=>`<a class="source-post-link" data-post-site="${site}" target="_blank" rel="noopener noreferrer" href="${esc(urls[site])}" title="原微博 ID ${safe} · weibo.${site}" aria-label="在 weibo.${site} 打开原微博 ${safe}">weibo.${site} ↗</a>`).join('')}</span>`;
}
function userLink(name,uid,authorUrl=''){
  const safe=positiveId(uid),label=text(name).trim()||safe||'未知用户';
  if(!safe&&authorUrl){try{const u=new URL(authorUrl);if(u.protocol==='https:'&&u.hostname==='weibo.cn'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/(?:n\/[^/]+|[a-zA-Z][\w-]{1,49})\/?$/.test(u.pathname))return `<a class="user-link" target="_blank" rel="noopener noreferrer" href="${esc(u.href)}" title="微博主页（UID 未确认）">${esc(label)}</a>`;}catch{}}
  return safe?`<a class="user-link" target="_blank" rel="noopener noreferrer" href="https://weibo.cn/u/${safe}" title="微博主页 · UID ${safe}" data-user-id="${safe}">${esc(label)}</a>`:`<span>${esc(label)}</span>`;
}
function replyPrefixParts(content){
  const raw=text(content),prefix=raw.match(/^[ \t]*回复[ \t]*@([^:：\r\n]+)[:：][ \t]*/u);
  if(!prefix||!prefix[1].trim())return null;
  return {name:prefix[1].trim(),body:raw.slice(prefix[0].length)};
}
function readingText(r){
 const content=text(r.content);
 if(r.group==='mentions-posts')return content;
 return replyPrefixParts(content)?.body??content;
}
function commentBodyHtml(r,full=false){
 const content=full?text(r.content):readingText(r);
 if(r.group==='mentions-posts')return linkedText(content||'（正文为空）');
 const pics=(Array.isArray(r.pictures?.items)?r.pictures.items:[]).slice(0,64).filter(p=>pictureUrl(p?.url)),locals=(Array.isArray(r.localImages)?r.localImages:[]).slice(0,128).filter(p=>typeof p?.file==='string'&&/^images\/[a-f0-9]{64}(?:_[a-f0-9]{16})?\.(?:jpg|png|gif|webp|avif)$/.test(p.file));
 const viewers=commentMediaEntries(r),pid=p=>p?.id||(()=>{try{const u=new URL(p?.url);return /(^|\.)sinaimg\.(cn|com)$/.test(u.hostname)?u.pathname.split('/').pop().replace(/\.[a-z\d]+$/i,''):'';}catch{return '';}})();
 for(const p of pics){const url=commentPictureViewer(p.url);if(url&&!viewers.some(v=>v.url===url))viewers.push({url,shortUrl:'',pictureIds:[]});}
 if(!pics.length&&!locals.length&&!viewers.length)return linkedText(content||'（正文为空）');
 const body=content.replace(/(?:^|\s)(?:评论配图\s*)+$/u,''),emitted=new Set(),usedLocal=new Set(),usedViewer=new Set();let bodyHtml=linkedText(body);const links=[];
 function item(p,local,related){
  const viewer=related.find(v=>v.shortUrl)||related[0],source=viewer&&(viewer.shortUrl||viewer.url),address=source||local?.file,label=source?(viewer?.shortUrl||'查看图片'):'本地配图',isLocal=!source&&!!local;
  if(local)usedLocal.add(local);for(const v of related)usedViewer.add(v);
  const aliases=new Set([p?.url,...related.flatMap(v=>[v.url,v.shortUrl])].filter(Boolean)),pattern=/<a class="content-link"[^>]*>[^<]*<\/a>/g,isAlias=anchor=>{const raw=unescapeEntities(anchor.match(/\bhref="([^"]*)"/)?.[1]||'');return aliases.has(raw)||aliases.has(commentPictureViewer(raw))||aliases.has(commentShortUrl(raw));};
  if(address){const primary=`<a class="content-link ${isLocal?'comment-local-picture-link':'comment-picture-link'}" href="${esc(address)}" data-comment-pictures target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="${esc(isLocal?'已保存的本地配图':'在微博官方看图页查看')}">${esc(label)}${isLocal?' ↗':''}</a>`;
   let present=false;bodyHtml=bodyHtml.replace(pattern,anchor=>{if(!isAlias(anchor))return anchor;if(emitted.has(address))return '';present=true;emitted.add(address);return primary.replace(/class="[^"]*"/,'class="content-link"');});if(!present&&!emitted.has(address)){emitted.add(address);links.push(primary);}if(full&&source&&local&&!emitted.has(local.file)){emitted.add(local.file);links.push(`<a class="content-link comment-local-picture-link" href="${esc(local.file)}" target="_blank" rel="noopener noreferrer">本地副本 ↗</a>`);}return;
  }
  if(viewers.length&&viewers.every(v=>!v.pictureIds?.length))return;
  links.push('<span class="comment-picture-unavailable">评论配图</span>');
 }
 for(const p of pics){const id=pid(p),local=locals.find(x=>x.url===p.url||id&&pid(x)===id)||null,related=viewers.filter(x=>x.pictureIds?.includes(id)||x.url===p.url||!x.pictureIds?.length&&pics.length===1&&viewers.length===1);item(p,local,related);}
 for(const local of locals)if(!usedLocal.has(local))item(null,local,[]);
 for(const viewer of viewers)if(!usedViewer.has(viewer))item(null,null,[viewer]);
 return (body?bodyHtml+' ':'')+'<span class="comment-picture-links" data-comment-pictures>'+links.join(' ')+'</span>';
}
function sortRecords(rows){
  return [...rows].sort((a,b)=>{
    if(a.ms==null&&b.ms!=null)return 1;if(a.ms!=null&&b.ms==null)return -1;
    if(a.ms!=null&&b.ms!=null&&a.ms!==b.ms)return b.ms-a.ms;
    const ai=BigInt(a.recordId||0),bi=BigInt(b.recordId||0);return ai===bi?0:bi>ai?1:-1;
  });
}
function terminalTarget(uid,nickname){
 const name=text(nickname).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g,' ').trim();
 return name?`${name}（UID ${uid}）`:`UID ${uid}（昵称未识别）`;
}
function copyButton(id,label){
 if(label==='UID')label=' UID';
 const value=positiveId(id);return value?`<button type="button" class="copy-id" data-copy-id="${value}" title="复制${esc(label)} ${value}" aria-label="复制${esc(label)} ${value}">复制${esc(label)}</button>`:'';
}
module.exports={CONVERSATION_HEADING_STYLE,MODES,ENDPOINTS,BASE,text,num,positiveId,reliableId,userId,userName,hasBefore,parseBefore,beforeDisplay,historySuffix,plan,unescapeEntities,cleanText,esc,linkedText,CONTENT_LINK_VERSION,COMMENT_PICTURE_VERSION,COMMENT_PICTURES_STYLE,pictureUrl,commentPictureViewer,commentShortUrl,commentMediaEntries,commentMediaUrls,postPictures,mergePostPictures,postShortId,commentUrl,postPicturesHtml,POST_PICTURES_STYLE,rawArray,apiError,executionFailed,unverifiedBilling,runCli,preflight,ts,normalize,recId,nameFromUser,targetNickname,safeName,postUrl,postUrls,displayPostUrl,confirmedAuthor,postLink,POST_LINKS_STYLE,userLink,replyPrefixParts,readingText,commentBodyHtml,sortRecords,terminalTarget,parsePostTarget,copyButton,accountColors,ACCOUNT_COLOR_STYLE,ACCOUNT_COLOR_SCRIPT,READING_STYLE,COPY_STYLE,COPY_SCRIPT};
