(function(root,factory){'use strict';const api=factory();if(typeof module!=='undefined'&&module.exports)module.exports={...api,createPostLinks:factory};else root.ReaderPostLinks=api;})(globalThis,function createPostLinks(){
 'use strict';
 const alphabet='0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',hosts=new Set(['weibo.com','www.weibo.com','weibo.cn','www.weibo.cn','m.weibo.cn']);
 function decimal(value){if(typeof value!=='string'&&typeof value!=='bigint'&&!(typeof value==='number'&&Number.isSafeInteger(value)))return '';const s=String(value);return /^\d{5,20}$/.test(s)&&BigInt(s)>0n?BigInt(s).toString():'';}
 function encode(value){const id=decimal(value);if(!id)return '';let bid='';for(let end=id.length;end>0;end-=7){let n=BigInt(id.slice(Math.max(0,end-7),end)),part='';do{part=alphabet[Number(n%62n)]+part;n/=62n;}while(n);bid=part.padStart(end>7?4:1,'0')+bid;}return bid;}
 function decode(bid){if(!/^[0-9a-zA-Z]{1,12}$/.test(bid))return '';let id='';for(let end=bid.length;end>0;end-=4){let n=0n;for(const c of bid.slice(Math.max(0,end-4),end))n=n*62n+BigInt(alphabet.indexOf(c));if(n>9999999n)return '';id=n.toString().padStart(end>4?7:1,'0')+id;}const numeric=decimal(id);return numeric&&encode(numeric)===bid?numeric:'';}
 function identify(value){if(typeof value!=='string'&&typeof value!=='bigint'&&!(typeof value==='number'&&Number.isSafeInteger(value)))return null;let token=String(value).trim(),short=false;if(/^https?:\/\//i.test(token)){let u;try{u=new URL(token);}catch{return null;}if(/^https?:\/\/[^/?#]*:/i.test(token)||!hosts.has(u.hostname.toLowerCase())||u.username||u.password||u.port||/%|\\/.test(u.pathname))return null;const parts=u.pathname.split('/').filter(Boolean);if(parts.length!==2)return null;if(['detail','status','comment'].includes(parts[0])){short=parts[0]==='comment'&&/^(?:www\.)?weibo\.cn$/.test(u.hostname);token=parts[1];}else if(/^\d{5,20}$/.test(parts[0])){short=true;token=parts[1];}else return null;}
  if(!short&&/^\d{5,20}$/.test(token)){const id=decimal(token);return id?{id,bid:encode(id)}:null;}const id=decode(token);return id?{id,bid:token}:null;
 }
 function parsePostTarget(value){const found=identify(value);if(!found)throw Error('缺少有效微博 ID 或链接；这不是微博详情链接');return found.id;}
 function postShortId(value){const id=decimal(value);return id?encode(id):'';}
 function crawlerPostPage(value,id){try{const u=new URL(value),bid=postShortId(id);return !!bid&&u.origin==='https://weibo.cn'&&!u.username&&!u.password&&u.pathname.replace(/\/$/,'')==='/comment/'+bid;}catch{return false;}}
 function commentUrl(postId,commentId){if(typeof postId!=='string'||typeof commentId!=='string')return '';const post=decimal(postId),comment=decimal(commentId);return post&&comment?'https://weibo.cn/comment/'+encode(post)+'?rl=0#C_'+comment:'';}
 function postUrl(value,authorUid=''){const found=identify(value);if(!found)return '';const uid=decimal(authorUid);return 'https://weibo.cn/comment/'+found.bid+'?'+(uid?'uid='+uid+'&':'')+'rl=0#cmtfrm';}
 // Explicit original-post controls offer both sites. Missing author identity uses
 // the desktop detail route; never borrow a target/commenter UID for that URL.
 function postUrls(value,authorUid=''){const found=identify(value);if(!found)return null;const uid=decimal(authorUid);return {com:'https://weibo.com/'+(uid?uid+'/'+found.bid:'detail/'+found.id)+'?from=feed#comment',cn:'https://weibo.cn/comment/'+found.bid+'?'+(uid?'uid='+uid+'&':'')+'rl=1#cmtfrm'};}
 // A URL in body text proves its post ID, not the original author's identity.
 function displayPostUrl(value){if(typeof value!=='string'||!/^https?:\/\//i.test(value))return '';return postUrl(value);}
 function authorIndex(rows){const by=new Map();for(const r of rows||[]){const id=String(r.postId||r.id||''),uid=decimal(r.postAuthorUid);if(!id||!uid)continue;if(!by.has(id))by.set(id,new Set());by.get(id).add(uid);}return Object.fromEntries([...by].map(([id,uids])=>[id,uids.size===1?[...uids][0]:'' ]));}
 function confirmedAuthor(rows,postId){return authorIndex(rows)[postId]||'';}
 // Read original-author metadata only from this exact post, never its comments or a report title.
 function savedPostAuthor(rows,postId){
  const empty={uid:'',nickname:''};if(typeof postId!=='string'||!decimal(postId))return empty;
  const scoped=(rows||[]).filter(r=>r?.postId===postId),uid=confirmedAuthor(scoped,postId);
  if(!uid&&scoped.some(r=>decimal(r.postAuthorUid)))return empty;
  const names=scoped.filter(r=>!uid||decimal(r.postAuthorUid)===uid).map(r=>typeof r.postAuthor==='string'?r.postAuthor.trim():'').filter(name=>name&&!/^(?:未知(?:用户|作者)?|未返回|未识别|昵称未(?:识别|返回)|(?:用户|UID)\s*\d{5,20})$/.test(name)&&name!==uid);
  return {uid,nickname:uid?names[0]||'':new Set(names).size===1?names[0]:''};
 }
 return {parsePostTarget,postShortId,crawlerPostPage,commentUrl,postUrl,postUrls,displayPostUrl,confirmedAuthor,savedPostAuthor,authorIndex};
});
