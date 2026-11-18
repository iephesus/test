'use strict';
// Field-level content fusion, independent of source and pagination evidence.
const S=require('./exchange-schema'),Q=require('./record-quality'),{completeBody}=require('./record-body');
const editable=kind=>['user-posts','mentions-posts'].includes(kind);
const pictures=row=>(row.pictures?.items||[]).map(p=>p.id||p.url||p).sort();
function version(row,kind){return S.hash(S.stable({id:row.recordId,content:Q.text(row),authorUid:row.authorUid||'',postId:row.postId||'',context:!!row.isContext,complete:completeBody(row),...(editable(kind)?{pictures:pictures(row),...(row.repost?{repost:version(row.repost,'user-posts')}: {})}:{} )}));}
function conflict(a,b,kind){
 if(!a||!b)return false;
 if(['recordId','authorUid','postId'].some(k=>a[k]&&b[k]&&a[k]!==b[k]))return true;
 if(!(a.isContext&&b.isContext)&&(!completeBody(a)||!completeBody(b)))return false;
 return Q.text(a)!==Q.text(b)||!!(editable(kind)&&(pictures(a).length&&pictures(b).length&&S.stable(pictures(a))!==S.stable(pictures(b))||a.repost&&b.repost&&version(a.repost,'user-posts')!==version(b.repost,'user-posts')));
}
const missing=v=>v==null||v==='';
const placeholder=v=>!v||/^(?:未知用户|用户\s*\d+)$/.test(v);
function merge(a,b,kind){
 if(!a)return {...b};if(!b)return {...a};if(conflict(a,b,kind))return {...a};
 // A quote cannot supply a formal body, even if it is longer or more precise.
 if(!!a.isContext!==!!b.isContext)return {...(a.isContext?b:a)};
 let main=a,extra=b;if(!completeBody(a)&&completeBody(b)){main=b;extra=a;}
 const relationCompatible=['replyId','rootId'].every(k=>!main[k]||!extra[k]||main[k]===extra[k]);
 const row={...main};for(const [k,v]of Object.entries(extra)){
  if(['bodyMissing','contentMissing','truncated','isContext','likes','time','ms','timePrecision','timeRaw','observedAt','replyRecord','repost','pictures','postPictures','commentMedia','content'].includes(k))continue;
  if(!relationCompatible&&['rootId','replyId','replyAuthor','replyAuthorUid','replyText','replyTime'].includes(k))continue;
  if(missing(row[k]))row[k]=v;
  else if(['author','replyAuthor','postAuthor'].includes(k)){
   if(placeholder(row[k]))row[k]=v;
   else if(!placeholder(v)&&row[k]!==v){const newer=Date.parse(extra.observedAt)>Date.parse(main.observedAt);if(newer)row[k]=v;}
  }
 }
 Object.assign(row,Q.mergeTime(main,extra));
 if(Q.text(main)===Q.text(extra)&&main.content!==extra.content)row.content=main.content.localeCompare(extra.content)<=0?main.content:extra.content;
 for(const k of ['pictures','postPictures'])if(main[k]||extra[k])row[k]=require('./core').mergePostPictures(main[k],extra[k]);
 const media=require('./comment-media').combine(main,extra,row);if(media)row.commentMedia=media;else delete row.commentMedia;
 if(relationCompatible&&main.replyRecord&&extra.replyRecord&&main.replyRecord.recordId===extra.replyRecord.recordId)row.replyRecord=merge(main.replyRecord,extra.replyRecord,'context');else if(relationCompatible&&!main.replyRecord&&extra.replyRecord&&(!row.replyId||row.replyId===extra.replyRecord.recordId))row.replyRecord=extra.replyRecord;
 if(main.repost&&extra.repost&&main.repost.recordId===extra.repost.recordId)row.repost=merge(main.repost,extra.repost,'user-posts');else if(!main.repost&&extra.repost)row.repost=extra.repost;
 if(main.likes==null&&extra.likes!=null)row.likes=extra.likes;
 else if(extra.likes!=null&&Date.parse(extra.observedAt)>Date.parse(main.observedAt))row.likes=extra.likes;
 // Compare instants, not spellings: a local +08:00 timestamp can sort after
 // a newer UTC timestamp. For equal instants keep a stable original spelling.
 const observed=[main.observedAt,extra.observedAt].filter(x=>Number.isFinite(Date.parse(x)));
 observed.sort((a,b)=>Date.parse(b)-Date.parse(a)||a.localeCompare(b));
 if(observed.length)row.observedAt=observed[0];
 if(completeBody(main))for(const k of ['bodyMissing','contentMissing','truncated'])delete row[k];return row;
}
function profileIndependent(row){const out={...row};for(const k of ['bodyMissing','contentMissing','truncated','isContext'])if(out[k]===false)delete out[k];for(const k of ['author','replyAuthor','postAuthor','likes','contextSource','type','group','localImages','observedAt'])delete out[k];return out;}
function same(a,b,kind){return !!a&&S.sameJSON(profileIndependent(merge(a,b,kind)),profileIndependent(a))&&!conflict(a,b,kind);}
// Body-version equivalence is intentionally narrower than persistence equality.
// A nickname/avatar/like enrichment must be saved even with the same body ID.
function persistedSame(a, b, kind) {
 if (!a || conflict(a, b, kind)) return false;
 const clean = row => {
  const out = S.row(row, kind);
  for (const key of ['bodyMissing', 'contentMissing', 'truncated', 'isContext']) {
   if (out[key] === false) delete out[key];
  }
  return out;
 };
 return S.sameJSON(clean(merge(a, b, kind)),clean(a));
}
module.exports={version,merge,conflict,same,persistedSame,editable};
