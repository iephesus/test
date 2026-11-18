'use strict';
// Only content fields belong in an exchange. Unknown fields are not copied.
const crypto = require('node:crypto');
const {exactId} = require('./completeness');
const TYPES = ['sent','received','mentions-comments','mentions-posts','post-comments','user-posts'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function stable(value) {
 if(Array.isArray(value)) return '['+Array.from(value,x=>stable(x)??'null').join(',')+']';
 if(value && typeof value==='object') return '{'+Object.keys(value).sort().flatMap(k=>{const v=stable(value[k]);return v===undefined?[]:[JSON.stringify(k)+':'+v];}).join(',')+'}';
 return JSON.stringify(value);
}
// Compare canonical JSON without allocating two complete serialized copies.
// Match stable's omitted object fields, null array holes and nonfinite values.
function sameJSON(a,b){
 if(a===b)return true;
 if(typeof a==='number'&&!Number.isFinite(a))a=null;if(typeof b==='number'&&!Number.isFinite(b))b=null;if(a===b)return true;
 if(Array.isArray(a)||Array.isArray(b)){if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(!sameJSON(a[i]===undefined?null:a[i],b[i]===undefined?null:b[i]))return false;return true;}
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 const ak=Object.keys(a).filter(k=>a[k]!==undefined),bk=Object.keys(b).filter(k=>b[k]!==undefined);return ak.length===bk.length&&ak.every(k=>Object.hasOwn(b,k)&&sameJSON(a[k],b[k]));
}
function id(value, zero=false) {
 if(typeof value==='number'&&!Number.isSafeInteger(value)) throw Error('数据包含不安全的数值 ID');
 if(zero && String(value)==='0') return '0';
 const result=exactId(value);if(!result||result.length>20)throw Error('数据包含无效 ID');return result;
}
function owner(value) {
 if(!value||!['user','post'].includes(value.kind)||typeof value.id!=='string'||!/^\d{5,20}$/.test(value.id)||id(value.id)!==value.id)throw Error('数据包对象身份无效');
 return {kind:value.kind,id:value.id};
}
const key = o => o.kind+':'+o.id;
function channel(o,kind) {if(!TYPES.includes(kind)||o.kind==='post'&&kind!=='post-comments'||o.kind==='user'&&kind==='post-comments')throw Error('对象与记录类型不匹配');return kind;}
function url(value) {
 if(value==null||value==='')return '';
 try {const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return '';for(const k of [...u.searchParams.keys()])if(/token|auth|secret|password|signature|credential|api.?key/i.test(k))u.searchParams.delete(k);u.hash='';return u.href;} catch{return '';}
}
function strings(source,target,fields){for(const k of fields)if(typeof source[k]==='string')target[k]=source[k];}
function scalars(source,target,fields){for(const k of fields)if(['boolean','number','string'].includes(typeof source[k])&&(!['number'].includes(typeof source[k])||Number.isFinite(source[k])))target[k]=source[k];}
function profile(raw) {
 if(!raw||typeof raw!=='object')return undefined;
 const uid=exactId(raw.idstr??raw.id??raw.uid);if(!uid)return undefined;
 const v={idstr:id(uid)};strings(raw,v,['screen_name','name','nickname']);return v;
}
function picture(raw,depth=0) {
 if(depth>8)throw Error('图片数据嵌套过深');if(typeof raw==='string')return url(raw);if(!raw||typeof raw!=='object')return undefined;
 if(Array.isArray(raw))return raw.map(x=>picture(x,depth+1));const v={};
 for(const k of ['url','original_pic','bmiddle_pic','thumbnail_pic'])if(typeof raw[k]==='string'){const u=url(raw[k]);if(u)v[k]=u;}
 strings(raw,v,['pid','pic_id','id']);
 for(const k of ['original','largest','large','bmiddle','thumbnail','data'])if(raw[k])v[k]=picture(raw[k],depth+1);
 strings(raw,v,['type']);return v;
}
function content(raw,depth=0) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||depth>18)throw Error('内容记录结构无效或嵌套过深');
 const v={},uid=exactId(raw.idstr??raw.id??raw.mid);if(uid)v.idstr=id(uid);
 for(const k of ['reply_idstr','reply_id','rootidstr','rootid','status_id','statusid'])if(raw[k]!=null&&String(raw[k])!=='')v[k]=id(raw[k],true);
 strings(raw,v,['text_raw','text','content','created_at','createdAt']);
 scalars(raw,v,['deleted','unavailable','truncated','is_long_text','isLongText','isContext','bodyMissing','contentMissing','like_counts','like_count','attitudes_count','reply_count','total_number','comments_count','pic_num']);
 for(const k of ['user','reply_user','target_user'])if(raw[k]){const u=profile(raw[k]);if(u)v[k]=u;}
 for(const k of ['status','weibo','reply_comment','retweeted_status'])if(raw[k])v[k]=content(raw[k],depth+1);
 for(const k of ['longText','long_text'])if(raw[k]&&typeof raw[k]==='object'){v[k]={};strings(raw[k],v[k],['longTextContent','content']);}
 for(const k of ['comments','replies','children'])if(raw[k]){
  if(Array.isArray(raw[k]))v[k]=raw[k].map(c=>content(c,depth+1));
  else {const a=require('./core').rawArray(raw[k],'post-comments');if(a){v[k]={comments:a.items.map(c=>content(c,depth+1))};scalars(a.container,v[k],['total_number','total']);}}
 }
 for(const k of ['pic_urls','pics'])if(Array.isArray(raw[k]))v[k]=picture(raw[k]);
 if(Array.isArray(raw.pic_ids))v.pic_ids=raw.pic_ids.filter(x=>typeof x==='string'&&/^[\w-]+$/.test(x));
 if(raw.pic_infos&&typeof raw.pic_infos==='object'){v.pic_infos={};for(const [k,p]of Object.entries(raw.pic_infos))if(/^[\w-]+$/.test(k)&&!['__proto__','constructor','prototype'].includes(k))v.pic_infos[k]=picture(p);}
 for(const k of ['original_pic','bmiddle_pic','thumbnail_pic']){const u=url(raw[k]);if(u)v[k]=u;}
 if(Array.isArray(raw.mix_media_info?.items))v.mix_media_info={items:raw.mix_media_info.items.filter(m=>['pic','image','photo'].includes(m.type)).map(m=>({type:m.type,data:picture(m.data)}))};
 const media=require('./comment-media').extract(raw);if(media)v.commentMedia=media;
 const refs=require('./comment-media').references(raw).filter(m=>m.commentId!==exactId(raw.idstr??raw.id??raw.mid));if(refs.length)v.commentMediaRefs=refs;
 return v;
}
function response(raw,kind) {
 const {rawArray,apiError}=require('./core'),a=rawArray(raw,kind);if(!a||apiError(raw))throw Error('内容响应缺失或失败');
 const v={[['user-posts','mentions-posts'].includes(kind)?'statuses':'comments']:a.items.map(x=>content(x))};
 const c=a.container;
 for(const k of ['next_cursor_str','next_cursor','max_id','since_id'])if(c[k]!=null)v[k]=id(c[k],true);
 for(const k of ['miss_ids_str','miss_ids'])if(Array.isArray(c[k]))v[k]=c[k].map(x=>id(x));
 scalars(c,v,['total_number','total','miss_count','has_more','more']);
 for(const k of ['status','weibo']){const s=c[k]||raw?.[k]||raw?.data?.[k];if(s)v[k]=content(s);}

 return v;
}
function row(raw,kind) {
 if(!raw||typeof raw!=='object')throw Error('独立记录格式无效');const v={recordId:id(raw.recordId||raw.id),group:kind};
 strings(raw,v,['type','author','time','content','postAuthor','postText','postTime','replyAuthor','replyText','replyTime','contextSource','timeRaw']);
 if(raw.authorUrl!=null){const u=new URL(raw.authorUrl);if(u.protocol!=='https:'||u.hostname!=='weibo.cn'||u.port||u.username||u.password||u.search||u.hash||!/^\/(?:n\/[^/]+|[a-zA-Z][\w-]{1,49})\/?$/.test(u.pathname))throw Error('作者主页链接无效');v.authorUrl=u.href;}
 if(raw.timePrecision!=null){if(!require('./record-quality').PRECISIONS.has(raw.timePrecision))throw Error('不支持的记录时间精度，请更新接收方软件');v.timePrecision=raw.timePrecision;}
 if(raw.observedAt!=null){if(typeof raw.observedAt!=='string'||!Number.isFinite(Date.parse(raw.observedAt)))throw Error('内容观测时间无效');v.observedAt=raw.observedAt;}
 for(const k of ['authorUid','postId','postAuthorUid','rootId','replyId','replyAuthorUid'])if(raw[k])v[k]=id(raw[k]);
 for(const k of ['ms','likes'])if(raw[k]!=null){if(typeof raw[k]!=='number'||!Number.isFinite(raw[k])){if(k==='ms'){v.bodyMissing=true;continue;}throw Error('记录数值无效');}v[k]=raw[k];}
 for(const k of ['bodyMissing','contentMissing','truncated','isContext'])if(raw[k]!=null){if(typeof raw[k]!=='boolean')throw Error('记录状态无效');v[k]=raw[k];}
 if(v.ms!=null&&!Number.isFinite(v.ms))throw Error('记录时间无效');
 if(raw.replyRecord)v.replyRecord=row({...raw.replyRecord,isContext:true},'context');
 if(raw.postPictures)v.postPictures=require('./core').mergePostPictures(raw.postPictures);
 if(raw.pictures)v.pictures=require('./core').mergePostPictures(raw.pictures);
 const media=require('./comment-media').normalize(raw.commentMedia,v);if(media)v.commentMedia=media;
 if(raw.repost)v.repost=row(raw.repost,'user-posts');
 if(raw.localImages)v.localImages=raw.localImages.map(x=>({file:assetPath(x.file),url:url(x.url),bytes:Number(x.bytes)||0}));
 if(raw.id)v.id=v.recordId;return v;
}
function assetPath(value){if(typeof value!=='string'||!/^images\/[a-f0-9]{64}(?:_[a-f0-9]{16})?\.(jpg|png|gif|webp|avif)$/.test(value))throw Error('图片内部路径无效');return value;}
function query(q,o,kind) {
 const v={uid:o.id,kind,count:Number(q.count),maxId:q.maxId||q.max_id||'',sinceId:q.sinceId||q.since_id||'',page:Number(q.page??1)};
 if(!Number.isSafeInteger(v.count)||v.count<1||v.count>(kind==='user-posts'?100:200)||!Number.isSafeInteger(v.page)||v.page<1)throw Error('请求身份或分页参数无效');
 if(q.uid&&id(q.uid)!==o.id)throw Error('请求对象不匹配');for(const k of ['maxId','sinceId'])if(v[k])v[k]=id(v[k]);
 if(kind==='user-posts'){
  for(const k of ['from','to']){if(q[k]!==undefined&&typeof q[k]!=='string')throw Error('日期请求身份不匹配');v[k]=q[k]??'';}
  for(const k of ['start_time','end_time'])if(q[k]!==undefined)v[k]=q[k];
  const p=require('./options').options([o.id,'user-posts',...(v.from?['--from',v.from]:[]),...(v.to?['--to',v.to]:[]),'--dry-run']);if(p.startTime!==q.start_time||p.endTime!==q.end_time)throw Error('日期请求身份不匹配');
 }
 return v;
}
function safePath(p){return typeof p==='string'&&p.length<300&&!p.includes('\\')&&!p.includes('\0')&&!p.startsWith('/')&&!p.split('/').some(x=>!x||x==='.'||x==='..')&&/^[A-Za-z0-9_./-]+$/.test(p);}
module.exports={TYPES,hash,stable,sameJSON,id,owner,key,channel,url,profile,content,response,row,assetPath,query,safePath};
