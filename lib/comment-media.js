'use strict';
// Comment viewer metadata is separate from downloadable image files. Returned
// comment/object identities, never a nickname or a CDN filename, bind the entry.
const exact=v=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):'';
const pictureId=v=>typeof v==='string'&&/^[A-Za-z\d_-]{8,100}$/.test(v)?v:'';
function mediaUrl(value){
 const official=require('./core').commentPictureViewer(value);if(official){const u=new URL(official);for(const key of [...u.searchParams.keys()])if(!['pos','emoticon'].includes(key))u.searchParams.delete(key);u.hash='';return u.href;}
 try{const u=new URL(typeof value==='string'&&value.startsWith('//')?'https:'+value:value);return ['http:','https:'].includes(u.protocol)&&u.hostname==='t.cn'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/[A-Za-z\d]{4,32}$/.test(u.pathname)?u.href:'';}catch{return '';}
}
function normalize(value,row){
 if(!value||value.schema!==1||exact(value.commentId)!==exact(row.recordId)||!exact(row.recordId))return null;
 const postId=exact(value.postId),authorUid=exact(value.authorUid);
 if(value.postId&&!postId||value.authorUid&&!authorUid||postId&&row.postId&&postId!==exact(row.postId)||authorUid&&row.authorUid&&authorUid!==exact(row.authorUid))return null;
 const items=[];
 for(const raw of (Array.isArray(value.items)?value.items:[]).slice(0,64)){
  const url=mediaUrl(raw?.url);if(!url)continue;
  const pictureIds=[...new Set((Array.isArray(raw.pictureIds)?raw.pictureIds:[]).map(pictureId).filter(Boolean))].sort();
  const shortUrl=mediaUrl(raw.shortUrl);const old=items.find(p=>p.url===url);
  if(old){old.pictureIds=[...new Set([...old.pictureIds,...pictureIds])].sort();if(!old.shortUrl&&shortUrl&&new URL(shortUrl).hostname==='t.cn')old.shortUrl=shortUrl;}
  else items.push({url,pictureIds,...(shortUrl&&new URL(shortUrl).hostname==='t.cn'?{shortUrl}:{})});
 }
 // An explicit saved short alias and its official URL are one entry, not two
 // conflicting viewers. Never infer aliases from text/ID similarity.
 const folded=items.filter(item=>{
  if(new URL(item.url).hostname!=='t.cn')return true;
  const linked=items.filter(other=>other!==item&&new URL(other.url).hostname==='photo.weibo.com'&&other.shortUrl===item.url&&(!item.pictureIds.length||item.pictureIds.every(id=>other.pictureIds.includes(id))));
  return linked.length!==1;
 });
 return folded.length?{schema:1,commentId:exact(row.recordId),postId,authorUid,items:folded}:null;
}
function mediaCandidates(raw){
 return [...(Array.isArray(raw.url_objects)?raw.url_objects:[]),...(Array.isArray(raw.url_struct)?raw.url_struct:[]),...(raw.pic&&typeof raw.pic==='object'?[raw.pic]:[]),...(Array.isArray(raw.pics)?raw.pics:[]),...Object.values(raw.pic_infos&&typeof raw.pic_infos==='object'?raw.pic_infos:{})].filter(n=>n&&typeof n==='object').slice(0,64);
}
function mediaNodes(candidate){return [candidate,candidate.info,candidate.object,candidate.object?.object,candidate.vip_gif].filter(x=>x&&typeof x==='object');}
function extract(raw){
 if(!raw||typeof raw!=='object')return null;
 const commentId=exact(raw.idstr??raw.id??raw.mid),posts=[raw.status?.idstr??raw.status?.id,raw.weibo?.idstr??raw.weibo?.id,raw.status_idstr??raw.status_id,raw.statusid].filter(v=>v!=null&&v!==''&&v!==0&&v!=='0').map(exact),authors=[raw.user?.idstr??raw.user?.id].filter(v=>v!=null&&v!=='').map(exact);
 if(!commentId||posts.some(id=>!id)||new Set(posts).size>1||authors.some(id=>!id))return null;
 const candidates=[];
 for(const candidate of mediaCandidates(raw)){
  const nodes=mediaNodes(candidate),declared=nodes.flatMap(n=>[n.comment_idstr??n.comment_id??n.cid].filter(v=>v!=null&&v!==''));if(declared.some(v=>exact(v)!==commentId))continue;
  const ids=nodes.flatMap(n=>[...(Array.isArray(n.pic_ids)?n.pic_ids:[]),n.pid,n.pic_id,...Object.keys(n.pic_infos||{})]).map(pictureId).filter(Boolean),official=nodes.some(n=>[n.url_long,n.target_url,n.h5_target_url,n.url,n.viewer_url,n.scheme].some(v=>require('./core').commentPictureViewer(v))),object=nodes.some(n=>[n.object_id,n.id].some(v=>typeof v==='string'&&/^1022:(?:230597(?:[a-f\d]{32}|6[A-Za-z\d]{16,64})|232975[1-9]\d{4,19})$/.test(v)));
  // Unrelated article/video objects have their own authors; they cannot vote on
  // this comment image's identity or suppress a valid returned viewer.
  if(!official&&!object&&!(ids.length&&(declared.length||candidate===raw.pic||(Array.isArray(raw.pics)&&raw.pics.includes(candidate))||nodes.some(n=>['comment_image','comment_picture','image','photo','pic'].includes(n.object_type)))))continue;
  const p=nodes.flatMap(n=>[n.status_idstr??n.status_id??n.statusid??n.post_id,n.status?.idstr??n.status?.id,n.weibo?.idstr??n.weibo?.id].filter(v=>v!=null&&v!=='')),u=nodes.flatMap(n=>[n.author_uid,n.user?.idstr??n.user?.id].filter(v=>v!=null&&v!==''));
  // Explicit claims must agree with each other even when the outer response
  // omits that identity. Preserve the confirmed binding instead of erasing it.
  if(p.some(v=>!exact(v))||u.some(v=>!exact(v)))return null;posts.push(...p.map(exact));authors.push(...u.map(exact));candidates.push({nodes,declared});
 }
 if(new Set(posts).size>1||new Set(authors).size>1)return null;
 const row={recordId:commentId,postId:posts[0]||'',authorUid:authors[0]||''},items=[],rootIds=require('./core').postPictures(raw).items.map(p=>pictureId(p.id)).filter(Boolean);
 const saved=normalize(raw.commentMedia,row);if(saved)items.push(...saved.items);
 for(const {nodes,declared}of candidates){
  const explicit=[...new Set(nodes.flatMap(n=>[...(Array.isArray(n.pic_ids)?n.pic_ids:[]),n.pid,n.pic_id,...Object.keys(n.pic_infos||{})]).map(pictureId).filter(Boolean))],ids=explicit.length?explicit:rootIds.length===1?rootIds:[];
  const addresses=nodes.flatMap(n=>[n.url_long,n.target_url,n.h5_target_url,n.url,n.url_short,n.short_url,n.viewer_url,n.scheme]).map(mediaUrl).filter(Boolean);
  const objects=nodes.flatMap(n=>[n.object_id,n.id]).filter(v=>typeof v==='string'&&/^1022:(?:230597(?:[a-f\d]{32}|6[A-Za-z\d]{16,64})|232975[1-9]\d{4,19})$/.test(v));
  if(declared.length&&ids.length)for(const id of objects)addresses.push('https://photo.weibo.com/h5/comment/compic_id/'+id);
  const official=addresses.filter(u=>new URL(u).hostname==='photo.weibo.com'),shortUrl=addresses.find(u=>new URL(u).hostname==='t.cn')||'',typed=nodes.some(n=>['comment_image','comment_picture','image','photo','pic'].includes(n.object_type));
  const selected=official.length?official:ids.length&&(declared.length||typed)&&shortUrl?[shortUrl]:[];
  for(const url of selected)items.push({url,pictureIds:ids,...(shortUrl?{shortUrl}:{})});
 }
 // A literal image-only comment can carry the real picture short link in its
 // body. Require one returned picture ID and the entire explicit image caption;
 // ordinary prose/other t.cn links never become picture metadata.
 const caption=typeof(raw.text_raw??raw.text)==='string'?(raw.text_raw??raw.text).trim():'',literal=caption.match(/^图片评论[ \t]+(https?:\/\/t\.cn\/[A-Za-z\d]{4,32})[ \t]*$/);
 if(literal&&rootIds.length===1){const url=mediaUrl(literal[1]),official=items.filter(item=>require('./core').commentPictureViewer(item.url)&&item.pictureIds.includes(rootIds[0]));if(url){if(official.length===1)official[0].shortUrl=url;else items.push({url,shortUrl:url,pictureIds:rootIds});}}
 return normalize({schema:1,commentId,postId:row.postId,authorUid:row.authorUid,items},row);
}
function combine(main,extra,row=main){
 const a=normalize(main?.commentMedia,row),b=normalize(extra?.commentMedia,row);
 // Explicit identity disagreements cannot donate media across body versions.
 if(extra&&['recordId','postId','authorUid'].some(k=>main?.[k]&&extra[k]&&main[k]!==extra[k]))return a;
 return normalize({schema:1,commentId:row.recordId,postId:row.postId||a?.postId||b?.postId||'',authorUid:row.authorUid||a?.authorUid||b?.authorUid||'',items:[...(a?.items||[]),...(b?.items||[])]},row);
}
function references(raw,depth=0){
 if(!raw||typeof raw!=='object'||depth>4)return [];
 const result=[],own=extract(raw),outerId=exact(raw.idstr??raw.id??raw.mid);if(own)result.push(own);
 for(const value of (Array.isArray(raw.commentMediaRefs)?raw.commentMediaRefs:[])){const media=normalize(value,{recordId:exact(value?.commentId)});if(media&&media.commentId!==outerId)result.push(media);}
 for(const candidate of mediaCandidates(raw)){
  const nodes=mediaNodes(candidate);
  const declared=nodes.flatMap(n=>[n.comment_idstr??n.comment_id??n.cid].filter(v=>v!=null&&v!=='')),ids=new Set(declared.map(exact));
  if(ids.size!==1||ids.has('')||ids.has(outerId))continue;
  // A quoted image object may identify another comment. It is media evidence
  // for that explicit ID, never a new formal body or the outer comment's photo.
  const media=extract({idstr:[...ids][0],url_objects:[candidate]});if(media)result.push(media);
 }
 if(raw.reply_comment)result.push(...references(raw.reply_comment,depth+1));
 const unique=new Map(),conflicts=new Set();for(const media of result){if(media.commentId===outerId&&!own||conflicts.has(media.commentId))continue;const old=unique.get(media.commentId);if(old&&['postId','authorUid'].some(k=>old[k]&&media[k]&&old[k]!==media[k])){unique.delete(media.commentId);conflicts.add(media.commentId);continue;}const binding={recordId:media.commentId,postId:old?.postId||media.postId,authorUid:old?.authorUid||media.authorUid};unique.set(media.commentId,old?normalize({...old,...binding,items:[...old.items,...media.items]},binding):media);}return [...unique.values()];
}
module.exports={exact,pictureId,mediaUrl,normalize,extract,references,combine};
