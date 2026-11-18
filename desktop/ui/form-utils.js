'use strict';
(function(root){
 const hosts=new Set(['weibo.cn','www.weibo.cn','weibo.com','www.weibo.com','m.weibo.cn']);
 function uid(value){if(typeof value==='number'&&!Number.isSafeInteger(value)||value&&typeof value==='object')return '';const text=String(value||'').trim();if(/^\d{5,20}$/.test(text))return text;try{const u=new URL(text);if(hosts.has(u.hostname)&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port)return u.pathname.match(/^\/(?:u\/)?(\d{5,20})\/?$/)?.[1]||'';}catch{}return '';}
 const dates=typeof module!=='undefined'&&module.exports?require('../../lib/date-range'):root.ReaderDates;
 const {validDay}=dates;
 function validate(q){
  const fail=(field,message)=>({field,message}),post=q.mode==='post-comments';
  if(!String(q.target||'').trim())return fail('target',post?'请填写微博 ID 或原微博链接。':'请填写用户 UID，或选择已保存的用户。');
  if(!post&&!uid(q.target))return fail('target','请输入数字 UID 或包含数字 UID 的微博用户主页链接，昵称可在下方用户列表中检索。');
  if(post&&!postId(q.target))return fail('target','请填写单条微博的 ID 或详情链接，不能使用用户主页链接。');
if(q.peerUid){if(q.policy!=='database'||!['comments-sent','comments-received','comments-both'].includes(q.mode))return fail('report-peer','互动对象仅用于用户评论的本地导出。');if(typeof q.peerUid!=='string'||!uid(q.peerUid))return fail('report-peer','互动对象请填写有效 UID 或用户主页链接。');if(uid(q.peerUid)===uid(q.target))return fail('report-peer','互动对象不能是目标用户本人。');}
  for(const [key,field,label,max,allowAll,required]of [['limit','limit',q.policy==='update'?'本次取数上限':'报告条数',null,true,!q.unlimited],['returnBudget','return-budget','新增返回预算',null,true,false],['pages','pages','新增请求上限',null,true,false],['pageSize','page-size','每页条数',q.mode==='user-posts'?100:200,false,false],['seekLimit','seek-limit','日期定位探测上限',null,true,false],['emptyWindowLimit','empty-limit','连续空窗口上限',null,true,false]]){
   if(key==='limit'&&q.unlimited||q.policy==='database'&&key!=='limit')continue;if(key==='seekLimit'&&!q.before&&!(q.syncOnly&&(q.from||q.to))||key==='emptyWindowLimit'&&q.mode!=='user-posts')continue;
   const v=String(q[key]??'').trim();if(!v&&!required)continue;if(allowAll&&v==='all')continue;const n=Number(v);
   if(!/^\d+$/.test(v)||!Number.isSafeInteger(n)||n<1)return fail(field,label+'请填写正整数'+(allowAll?'，或 all 表示不限。':'。'));
   if(max&&n>max)return fail(field,label+'最多 '+max+' 条；总条数请在数量栏设置。');
  }
  if(q.from&&!validDay(q.from))return fail('from','请选择有效的起始日期。');if(q.to&&!validDay(q.to))return fail('to','请选择有效的截止日期。');if(q.from&&q.to&&q.from>q.to)return fail('to','截止日期不能早于起始日期。');
  if(q.before&&!validDay(q.before))return fail('before','请选择有效的截止日期。');return null;
 }
 function scope(q){
  const unlimited=q.unlimited||q.limit==='all',n=Number.isSafeInteger(Number(q.limit))&&Number(q.limit)>0?Number(q.limit):50,split=['comments-both','comments-and-mentions'].includes(q.mode),many=q.mode==='comments-and-mentions',update=q.policy==='update';
  const num=value=>value.toLocaleString('en-US'),total=many?(BigInt(n)*3n).toLocaleString('en-US'):num(n);
  const pair=split?`发出 ${num(Math.ceil(n/2))} 条 + 收到 ${num(Math.floor(n/2))} 条`:'';
  let hint=unlimited?(update?'读取本轮全部新增，可能连续计费；报告合并已保存记录。':'读取接口可见范围，可能连续调用付费接口。'):update?(many?`双向评论 ${pair}，评论 @ 和微博 @ 各 ${num(n)} 条；本次新返回合计最多 ${total} 条。`:split?`本次新返回最多 ${num(n)} 条：${pair}。`:`本次新返回最多 ${num(n)} 条。`)+` 报告${many?'每份':''}最多 ${num(n)} 条，旧缓存免费复用。`:many?`生成三份报告：双向评论 ${pair}，评论 @ 和微博 @ 各最多 ${num(n)} 条。`:split?`${pair}；分别取数，不代表按时间合并的全局最新 ${num(n)} 条。`:'引用上下文不计入正式条数。';
  if(q.mode==='user-posts')hint='日期可只填一端，包含所选当天；留空的一端不设限制。'+(q.downloadImages?'图片保存到本机后占用磁盘空间。':'图片保持链接，不自动下载。');
  if(q.syncOnly&&['comments-sent','comments-received','comments-both','comments-and-mentions','mentions-in-comments','mentions-in-posts'].includes(q.mode))return {unlimited,summary:unlimited?(q.from||q.to?'所选日期范围内全部数据':update?'全部新增':'全部可见数据'):'最多 '+num(n)+' 条',hint:(split?(unlimited?'发出、收到分别读取；':pair+'；两方向额度独立，不是按时间合并的全局最新 '+num(n)+' 条。'):'')+(update?'只保存成功位置之后的新增；不以历史数据凑满额度。无可靠起点的方向自动首次读取。':q.from||q.to?'覆盖该日期范围内最近的数据，本地完整正文计入目标；包含起止当天。':'覆盖最近的数据，已有完整本地数据计入条数；不足时才向前补充。'),warning:unlimited?'“全部”仍受所选日期、返回预算与异常保护约束，可随时停止。':'',note:'重复返回与定位同样占新增返回预算；已保存的数据和断点保留。'};
  if(q.policy==='database')return {unlimited,summary:unlimited?'全部匹配的本地记录':(many?'3 份 · 各最多 ':'最多 ')+num(n)+' 条本地记录',hint:(q.from||q.to?'筛选所选范围内已保存的独立记录，包含填写当天。':'从全部已保存日期中选择记录；不会补取本地没有的内容。')+(split&&!unlimited?'发出与收到合并，按时间选择最新的 '+num(n)+' 条。':''),warning:'',note:'仅查询本地数据，不联网，不新增 credits；匹配数量不代表完整线上历史。'};
  return {unlimited,summary:unlimited?(update?'全部新增':'全部可见记录'):(many?'3 份 · 各最多 ':'最多 ')+num(n)+' 条',hint,warning:q.policy==='offline'?'':unlimited?'已选择不限量，请留意累计费用；可随时停止，已有缓存保留。':q.policy==='refresh'?'重新核查会再次请求旧数据，已保存的记录再次返回也可能计费。':'',note:q.policy==='update'?'重复与边界核对也占本次取数额度；未读完保存位置，下次继续。':q.policy==='offline'?'本次仅用本地数据，不新增取数费用。':q.policy==='refresh'?'保留旧快照，不覆盖丢失的历史原文。':'先用缓存，缓存不足时联网补取。'};
 }
 const links=typeof module!=='undefined'&&module.exports?require('../../lib/post-links'):root.ReaderPostLinks;
 function postId(value){try{return links.parsePostTarget(value);}catch{return '';}}
 const api={postId,uid,validDay,validate,scope};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ReaderUX=api;
})(globalThis);
