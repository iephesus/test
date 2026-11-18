'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {text,positiveId,reliableId,userId,userName,nameFromUser,rawArray,apiError,unverifiedBilling,runCli,cleanText,ts,postPictures,mergePostPictures,terminalTarget}=require('./core');
const {storagePaths,indexRead,mappedFolder,commitName}=require('./storage');
const {cachePostImages}=require('./image-cache');
const {renderUserPosts}=require('./posts-reader');
const {reportShortcut,createProgress,requestPolicy,conciseError}=require('./terminal-report');

const POSTS_ENDPOINT=['statuses','user_timeline/other'];
const {postsOptions}=require('./options');
function receivedJSON(dir,endpoint,query,readText){
 const responseText=readText(),requestId=crypto.randomUUID(),file=path.join(dir,'cache/audit/user-posts-responses',requestId+'.received.json'),savedAt=new Date().toISOString();
 const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),box={schema:1,type:'user-posts-received',requestId,endpoint,query:structuredClone(query),queryHash:hash(JSON.stringify(query)),responseText,responseTextHash:hash(responseText),savedAt};
 let evidence;
 try{const bytes=Buffer.from(JSON.stringify(box));evidence={file:path.relative(dir,file),hash:require('./durable-write').atomicBytes(file,bytes),responseTextHash:box.responseTextHash,requestId};}
 catch(error){throw Object.assign(Error('微博原始返回未能可靠保存，已停止后续请求；费用待核实'),{code:'REQUEST_EVIDENCE_INVALID',apiAttempt:true,responseReceived:true,responseSaved:false,billingUnknown:true,receiptSaveCode:require('./diagnostic-codes').safe(error.code)});}
 let raw;
 try{raw=JSON.parse(responseText);}
 catch{throw Object.assign(Error('微博响应不是完整有效的 JSON，原始返回已保存；未继续读取，费用待核实'),{code:'REQUEST_EVIDENCE_INVALID',apiAttempt:true,responseReceived:true,responseSaved:true,billingUnknown:true,receivedEvidence:evidence});}
 const message=apiError(raw);
 if(message||!rawArray(raw,'user-posts'))throw Object.assign(Error(message||'响应缺少微博列表，原始响应已保存'),{code:'REQUEST_EVIDENCE_INVALID',apiAttempt:true,responseReceived:true,responseSaved:true,billingUnknown:true,receivedEvidence:evidence});
 return {raw,evidence};
}
function responseQuery(o,{count,maxId='',purpose,requestedIds=[]}){
 return {uid:o.uid,from:o.from||'',to:o.to||'',start_time:o.startTime??null,end_time:o.endTime??null,count,max_id:maxId,page:purpose==='user-timeline'?1:null,purpose,requestedIds:[...requestedIds]};
}
function checkPostsMetadata(){
 const raw=JSON.parse(runCli(['commands','show',...POSTS_ENDPOINT,'--output','json'])),c=raw.command||raw,flags=new Set((c.flags||[]).map(f=>f.name));
 if(c.group!=='statuses'||c.action!=='user_timeline/other'||c.method!=='GET'||!['uid','count','page','max_id','start_time','end_time'].every(name=>flags.has(name)))throw Error('当前接口未确认支持账户微博日期筛选，已在付费请求前停止');
 return {unitPrice:require('./command-pricing').parse(raw,{group:POSTS_ENDPOINT[0],action:POSTS_ENDPOINT[1],types:['per_record']})?.unitPrice??null};
}
function postsCacheFile(dir,o,count,cursor){return path.join(dir,'cache',`user-posts_${o.from.replaceAll('-','')}_${o.to.replaceAll('-','')}_c${count}_m${cursor||'0'}.json`);}
function getUserPostsPage(o,dir,count,cursor){
 if(!o.refresh){const packet=require('./exchange-records').packets(dir,'user-posts',o.uid).filter(p=>p.query.count===count&&p.query.maxId===(cursor||'')&&p.query.from===o.from&&p.query.to===o.to&&p.query.start_time===o.startTime&&p.query.end_time===o.endTime).sort((a,b)=>b.cacheTimeMs-a.cacheTimeMs)[0];if(packet)return packet;}
 const file=postsCacheFile(dir,o,count,cursor),cacheDir=path.dirname(file),prefix=`user-posts_${o.from.replaceAll('-','')}_${o.to.replaceAll('-','')}_c`,suffix='_m'+(cursor||'0')+'.json';
 if(!o.refresh&&fs.existsSync(cacheDir)){
  const candidates=fs.readdirSync(cacheDir).filter(name=>name.startsWith(prefix)&&name.endsWith(suffix)).map(name=>({file:path.join(cacheDir,name),count:Number(name.slice(prefix.length,-suffix.length))})).filter(c=>Number.isSafeInteger(c.count)&&c.count>0).sort((a,b)=>(a.count>=count?0:1)-(b.count>=count?0:1)||(a.count>=count?a.count-b.count:b.count-a.count));
  for(const candidate of candidates){
   const saved=JSON.parse(fs.readFileSync(candidate.file,'utf8')),q=saved.query;
   if(saved.schema!==1||q?.uid!==o.uid||q.from!==o.from||q.to!==o.to||q.start_time!==o.startTime||q.end_time!==o.endTime||q.max_id!==(cursor||'')||saved.endpoint!==POSTS_ENDPOINT.join(' '))continue;
   if(!apiError(saved.response)&&rawArray(saved.response,'user-posts'))return {raw:saved.response,cached:true,file:candidate.file,pricing:saved.pricing};
  }
 }
 if(o.offline)return null;
 const args=[...POSTS_ENDPOINT,'--uid',o.uid,'--count',String(count),'--page','1','--feature','0','--base_app','0'];
 if(o.from)args.push('--start_time',String(o.startTime));if(o.to)args.push('--end_time',String(o.endTime));
 if(cursor)args.push('--max_id',cursor);args.push('--output','json');
 let raw,evidence;try{({raw,evidence}=receivedJSON(dir,POSTS_ENDPOINT.join(' '),responseQuery(o,{count,maxId:cursor||'',purpose:'user-timeline'}),()=>runCli(args)));}catch(error){
  const message=error.message,folder=path.join(cacheDir,'errors'),rejection=require('./service-rejection').safeCapture(error.serviceRejectionCapture);error.apiAttempt=true;error.billingUnknown=true;
  if(rejection)error.responseReceived=true;
  try{fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,Date.now()+'_'+crypto.randomUUID()+'.json'),JSON.stringify({endpoint:POSTS_ENDPOINT.join(' '),query:responseQuery(o,{count,maxId:cursor||'',purpose:'user-timeline'}),savedAt:new Date().toISOString(),error:message,code:require('./diagnostic-codes').safe(error.code),...(error.receivedEvidence?{receivedEvidence:error.receivedEvidence}:{}),...(rejection?{serviceRejection:rejection,billing:'unverified'}:{})}));if(rejection){error.responseSaved=true;error.returnedRecords=0;}}
  catch(saveError){error.code='REQUEST_EVIDENCE_INVALID';error.message=error.responseSaved?'微博原始返回已保存，但错误摘要未能保存；未继续读取，费用待核实':'微博请求的错误记录未能保存，费用状态未知；未继续读取';error.responseSaved=!!error.responseSaved;error.receiptSaveCode=require('./diagnostic-codes').safe(saveError.code);}
  throw error;
 }
 try{
  fs.mkdirSync(cacheDir,{recursive:true});
  if(fs.existsSync(file)){const old=fs.readFileSync(file),hash=crypto.createHash('sha256').update(old).digest('hex').slice(0,16),archive=file.replace(/\.json$/,'_legacy_'+hash+'.json');if(!fs.existsSync(archive))fs.copyFileSync(file,archive);}
  fs.writeFileSync(file,JSON.stringify({schema:1,endpoint:POSTS_ENDPOINT.join(' '),query:{uid:o.uid,from:o.from,to:o.to,start_time:o.startTime,end_time:o.endTime,max_id:cursor||'',count},savedAt:new Date().toISOString(),pricing:o.pricing,response:raw,receivedEvidence:evidence}));
  return {raw,cached:false,file,pricing:o.pricing};
 }catch(error){throw Object.assign(Error('微博原始返回已保存，但正文缓存未能更新；已停止后续请求，费用待核实'),{code:'REQUEST_EVIDENCE_INVALID',apiAttempt:true,responseReceived:true,responseSaved:true,billingUnknown:true,returnedRecords:rawArray(raw,'user-posts')?.items.length,receivedEvidence:evidence,receiptSaveCode:require('./diagnostic-codes').safe(error.code)});}
}
function safePostId(raw){
 const id=reliableId('微博 ID',raw?.idstr,raw?.id,raw?.mid);if(!id)throw Error('微博缺少有效 ID');return id;
}
function contentOf(raw){return cleanText(raw.longText?.longTextContent??raw.long_text?.longTextContent??raw.text_raw??raw.text??'');}
function postIsTruncated(raw){return !(raw.longText?.longTextContent||raw.long_text?.longTextContent)&&[raw.truncated,raw.is_long_text,raw.isLongText].some(value=>value===true||value===1||value==='1');}
function normalizeUserPost(raw){
 const id=safePostId(raw),time=ts(raw.created_at??raw.createdAt);
 const row={id,recordId:id,raw,author:userName(raw.user),authorUid:userId(raw.user),content:contentOf(raw),...require('./record-quality').timeFields(raw.created_at??raw.createdAt,time.display,time.ms),pictures:postPictures(raw),truncated:postIsTruncated(raw),repost:null};
 if(raw.retweeted_status&&typeof raw.retweeted_status==='object'){
  const source=raw.retweeted_status,stamp=ts(source.created_at??source.createdAt);
  row.repost={id:reliableId('转发原微博 ID',source.idstr,source.id,source.mid),author:userName(source.user),authorUid:userId(source.user),content:contentOf(source),...require('./record-quality').timeFields(source.created_at??source.createdAt,stamp.display,stamp.ms),pictures:postPictures(source),truncated:postIsTruncated(source)};
 }
 return row;
}
function timelineCursor(raw){
 const box=rawArray(raw,'user-posts')?.container||{},value=box.next_cursor_str??box.next_cursor;
 if(value==null)return null;if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('续取游标超出安全整数范围');
 if(!/^\d+$/.test(String(value)))throw Error('无法识别的续取游标');return BigInt(value).toString();
}
function harvestUserPosts(o,dir,fetchPage=getUserPostsPage){
 const out={rows:[],requests:0,apiCalls:0,cachedCalls:0,newFetched:0,name:'',complete:false,verified:false,failed:false,billingUnknown:false,reason:'',unitPrice:o.pricing?.unitPrice??null};
 const progress=createProgress(o);
 const unique=new Map(),seen=new Set();let cursor='',emptyWindows=0;
 for(;;){
  const wanted=out.verified?Math.min(o.pageSize,o.count-unique.size):1;if(wanted<=0){out.reason='达到 --limit / --count 条数上限，尚未取完整个日期区间';break;}
  const capped=out.apiCalls>=o.pages;let packet;
  try{packet=fetchPage({...o,offline:o.offline||capped},dir,wanted,cursor);}catch(error){out.failed=true;out.apiCalls+=require('./collection-failure').accountFailure(out,error).apiCalls;out.stopCode=require('./diagnostic-codes').safe(error.code);out.reason='请求失败：'+error.message;break;}
  if(!packet){out.reason=capped?'达到 --pages 新增 API 上限，尚未取完整个日期区间':'离线缓存不足，尚未取完整个日期区间';break;}
  out.requests++;if(packet.cached)out.cachedCalls++;else out.apiCalls++;
  const parsed=rawArray(packet.raw,'user-posts');if(!parsed||apiError(packet.raw)){out.failed=true;out.billingUnknown=out.billingUnknown||!packet.cached;out.reason=apiError(packet.raw)||'响应缺少微博列表';break;}
  const items=parsed.items;if(!packet.cached){out.newFetched+=items.length;if(unverifiedBilling(packet.raw))out.billingUnknown=true;}
  let next,cursorError='';try{next=timelineCursor(packet.raw);}catch(error){cursorError=error.message;}
  let bad='';const valid=[];let smallest=null;
  for(const raw of items){
   try{
    const row=normalizeUserPost(raw),id=BigInt(row.id);smallest=smallest==null?id:(id<smallest?id:smallest);
    if(userId(raw.user)!==o.uid){bad='返回微博作者与目标 UID 不一致或未返回作者 UID';continue;}
    if(!Number.isFinite(row.ms)){bad='微博时间无法识别，日期范围尚未核实';continue;}
    if(cursor&&id>BigInt(cursor)){bad='接口未遵守 max_id 续取边界';continue;}
    if(row.ms<o.startMs-1000||row.ms>o.endMs+1000){bad='接口未遵守 start_time / end_time 日期范围，已停止，未扫描其他日期';continue;}
    if(row.ms>=o.startMs&&row.ms<=o.endMs){valid.push(row);if(!out.name)out.name=nameFromUser(raw.user,o.uid);}
   }catch(error){bad=error.message;}
  }
  const accepted=[];
  for(const row of valid)if(!unique.has(row.id)&&unique.size<o.count){unique.set(row.id,row);accepted.push(row);}
  o.noteNewRecords?.(accepted);
  require('./events').emit('credits',{estimatedCredits:out.unitPrice==null?(out.newFetched?null:0):out.unitPrice*out.newFetched,unknownRequests:out.billingUnknown?1:0,returnedRecords:out.newFetched,finished:false,initialBalance:null,finalBalance:null,offline:!!o.offline});
  require('./events').emit('collection',{kind:'user-posts',phase:out.verified?'collect':'seek',fetched:unique.size,budget:out.verified&&Number.isFinite(o.count)?o.count:null});
  progress.update(`${out.verified?'采集':'日期核对'} · ${unique.size} 条 · API ${out.apiCalls} 次`, `  ${out.verified?'采集':'日期核对'} #${out.requests} | ${packet.cached?'缓存':'API'}返回 ${items.length} 条，区间内去重 ${unique.size} 条${cursor?' | max_id '+cursor:''}`);
  if(bad){out.failed=true;out.reason=bad;break;}
  if(cursorError){out.failed=true;out.reason=cursorError;break;}
  if(!packet.cached&&items.length>wanted){out.failed=true;out.reason='接口返回数超过请求额度，已保留返回内容并停止';break;}
  if(items.length)out.verified=true;
  if(unique.size>=o.count){out.reason='达到 --limit / --count 条数上限，尚未取完整个日期区间';break;}
  if(!items.length){
   if(next&&next!=='0'){if(++emptyWindows>=(o.emptyWindowLimit??20)){out.reason='达到 --empty-window-limit 连续空窗口上限，尚未核实日期区间；可增大该值或设为 all';break;}}
   else{out.complete=true;out.reason=unique.size?'接口在该日期范围返回末页，仅代表当前接口可见范围':'接口未返回区间内微博；不能据此判断没有发布或半年可见之外不存在微博';break;}
  }else emptyWindows=0;
  // Some timeline envelopes use zero as a placeholder even on nonempty pages.
  if(items.length&&next&&next!=='0'&&smallest!=null&&BigInt(next)>smallest){out.failed=true;out.reason='续取游标越过当前页边界，已安全停止';break;}
  // A nonempty timeline page can be continued conservatively from its last returned ID.
  // Do not let an undocumented next_cursor jump over potentially unread status IDs.
  const proposed=items.length?(smallest!=null&&smallest>1n?(smallest-1n).toString():''):(next&&next!=='0'?next:'');
  if(!proposed||(cursor&&BigInt(proposed)>=BigInt(cursor))||seen.has(proposed)||(smallest!=null&&BigInt(proposed)>smallest)){out.failed=true;out.reason='续取游标缺失、重复或未向前推进，已安全停止';break;}
  seen.add(proposed);cursor=proposed;
 }
 if(!out.reason)out.reason='采集已停止，尚未核实日期区间';
 progress.end();out.rows=[...unique.values()].sort((a,b)=>b.ms-a.ms||(BigInt(a.id)>BigInt(b.id)?-1:1));return out;
}
function mergePostDetail(row,entry){
 const normalized=normalizeUserPost({...row.raw,...entry});
 normalized.pictures=mergePostPictures(row.pictures,normalized.pictures);
 if(normalized.repost&&row.repost?.id===normalized.repost.id)normalized.repost.pictures=mergePostPictures(row.repost.pictures,normalized.repost.pictures);
 Object.assign(row,normalized);
}
function fillPostDetails(o,dir,result){
 const pending=[];result.detailRecords=0;result.detailApiCalls=0;result.detailCached=0;result.detailWarnings=[];
 for(const row of result.rows){
  if(!row.truncated)continue;const file=path.join(dir,'cache','details',row.id+'.json');
  if(!o.refresh&&fs.existsSync(file)){
   try{const raw=JSON.parse(fs.readFileSync(file,'utf8'));if(safePostId(raw)===row.id&&userId(raw.user)===o.uid){mergePostDetail(row,raw);result.detailCached++;if(!row.truncated)continue;}}catch{}
  }
  pending.push(row);
 }
 if(!pending.length)return;
 if(o.offline){result.detailWarnings.push(`${pending.length} 条正文未完整返回，离线模式不补取`);return;}
 let metadata;try{metadata=JSON.parse(runCli(['commands','show','statuses','show_batch/biz','--output','json']));}catch(error){result.detailWarnings.push('详情接口校验失败，已保留当前记录：'+error.message.slice(0,180));return;}
 const command=metadata.command||metadata,flags=new Set((command.flags||[]).map(f=>f.name));
 if(command.method!=='GET'||command.group!=='statuses'||command.action!=='show_batch/biz'||!flags.has('ids')||!flags.has('isGetLongText')){result.detailWarnings.push('详情接口未确认，未新增详情请求');return;}
 result.detailPrice=require('./command-pricing').parse(metadata,{group:'statuses',action:'show_batch/biz',types:['per_record']})?.unitPrice??null;
 for(let at=0;at<pending.length;at+=50){
  if(result.apiCalls+result.detailApiCalls>=o.pages){result.detailWarnings.push('达到 --pages 请求上限，剩余正文未补齐');break;}
  const group=pending.slice(at,at+50),ids=group.map(row=>row.id);let raw;
  try{
   result.detailApiCalls++;const received=receivedJSON(dir,'statuses show_batch/biz',responseQuery(o,{count:ids.length,purpose:'post-details',requestedIds:ids}),()=>runCli(['statuses','show_batch/biz','--ids',ids.join(','),'--isGetLongText','1','--output','json']));raw=received.raw;
   const folder=path.join(dir,'cache','details');fs.mkdirSync(folder,{recursive:true});const hash=crypto.createHash('sha256').update(ids.join(',')).digest('hex').slice(0,16);
   fs.writeFileSync(path.join(folder,'batch_'+Date.now()+'_'+hash+'.json'),JSON.stringify(raw));
   const items=rawArray(raw,'user-posts').items;result.detailRecords+=items.length;if(unverifiedBilling(raw))result.billingUnknown=true;
   for(const entry of items){const id=safePostId(entry),row=group.find(r=>r.id===id);if(!row||userId(entry.user)!==o.uid)continue;fs.writeFileSync(path.join(folder,id+'.json'),JSON.stringify(entry));mergePostDetail(row,entry);}
  }catch(error){result.billingUnknown=true;result.detailFailed=true;result.detailWarnings.push('详情补取失败：'+error.message.slice(0,180));break;}
 }
 if(result.rows.some(row=>row.truncated))result.detailWarnings.push('部分正文仍不完整，页面已逐条标明');
}
function knownPostsAccount(o){
 const paths=storagePaths(),own=indexRead(paths.posts),comments=indexRead(paths.users),old=indexRead(paths.oldUsers);
 return {root:paths.posts,index:own,name:text(own[o.uid]?.nickname||comments[o.uid]?.nickname||old[o.uid]?.nickname||'')};
}
function runUserPosts(o){
 o.syncStartedAt=new Date().toISOString();
 const account=knownPostsAccount(o);console.log(`目标：${terminalTarget(o.uid,account.name)} | user-posts`);
 console.log(`日期范围：${require('./date-range').label(o.from,o.to)}（包含起止两天） | ${Number.isFinite(o.count)?'最多 '+o.count+' 条':'自动读取区间内可见微博'}`);
 if(o.dryRun){console.log(`  statuses user_timeline/other --uid ${o.uid} ${o.from?'--start_time '+o.startTime+' ':''}${o.to?'--end_time '+o.endTime+' ':''} --count 1 --page 1 --feature 0 --base_app 0`);console.log('  首次最多请求 1 条核对日期，随后每页最多 '+o.pageSize+' 条；缓存优先。');console.log(`  图片：${o.downloadImages?'可选本地保存，图片下载不增加 CLI credits':'使用微博图片页链接'}；全文：${o.fullText?'仅对截断正文补取详情，可能额外计费':'保留返回正文并标记截断，不额外付费补取'}`);return;}
 console.log(requestPolicy(o));
 fs.mkdirSync(account.root,{recursive:true});let dir=mappedFolder(account.root,o.uid,account.index);fs.mkdirSync(dir,{recursive:true});
 o.pricing=o.offline?null:checkPostsMetadata();if(o.pricing)console.log(`计费：${o.pricing.unitPrice==null?'接口未提供可核实单价':o.pricing.unitPrice+' credits / 新返回微博'}；先单条核对日期，再正常采集。`);
 const beforeKeys=o.syncOnly?new Set(require('./local-database').localPosts(o,dir,{enrich:false}).rows.map(require('./database-sync').key)):null;
 require('./database-sync').trackNewRecords(o,beforeKeys);
 const balance=()=>{try{const value=JSON.parse(runCli(['me','--output','json'],{timeout:10000})).user?.balance;if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))return null;const amount=Number(value);return Number.isFinite(amount)&&amount>=0?amount:null;}catch{return null;}};const initialBalance=o.syncOnly&&!o.offline?balance():null;
 const result=harvestUserPosts(o,dir);if(o.fullText&&!result.failed)fillPostDetails(o,dir,result);
 const named=commitName(account.root,o.uid,dir,account.index,result.name||account.name);dir=named.folder;
 if(o.downloadImages&&!result.failed&&!result.detailFailed)result.images=cachePostImages(result.rows,dir,o);
 const label=named.label||o.uid,partial=!result.complete;let writtenFile='';
 if(!o.syncOnly&&result.rows.length){
  require('./data-layout').mirrorImages(dir);
  const file=path.join(require('./data-layout').reportDir(dir),require('./report-name').fileName(label,o,result.rows.length));
  const catalog=require('./report-catalog');writtenFile=catalog.write(file,{...o,reportPartial:partial},result.rows,label,()=>renderUserPosts(o,result,label),catalog.contentKey(o,result.rows,[result],label)).file;
 }else if(!result.rows.length)console.log('未取得区间内微博，未生成 0 条 HTML。');
 const detailCalls=result.detailApiCalls||0,detailRecords=result.detailRecords||0;
 const unknownPriceRequests=(result.unitPrice==null?result.apiCalls:0)+(result.detailPrice==null?detailCalls:0),unknownRequests=Math.max(result.billingUnknown?1:0,unknownPriceRequests);
 result.billingUnknown=unknownRequests>0;
 const hasPricedReturns=result.newFetched>0&&result.unitPrice!=null||detailRecords>0&&result.detailPrice!=null;
 const estimate=hasPricedReturns||!result.billingUnknown?result.newFetched*(result.unitPrice??0)+detailRecords*(result.detailPrice??0):null;
 console.log(`[结果] ${terminalTarget(o.uid,result.name||account.name)} | 导出 ${result.rows.length} 条 | ${conciseError(result.reason,o)}`);
 console.log(`API ${result.apiCalls+detailCalls} 次，列表新返回 ${result.newFetched} 条，详情新返回 ${detailRecords} 条 | 缓存 ${result.cachedCalls+(result.detailCached||0)} 次${estimate==null?'':' | 按已知返回记录估算 '+estimate+' credits（以服务端扣费为准）'}`);
 if(result.billingUnknown)console.log('注意：有请求的计费结果或单价尚未核实，不能据此断言扣费为 0。');
 if(result.images)console.log(`图片：新下载 ${result.images.downloaded} 张，复用 ${result.images.reused} 张，失败 ${result.images.failed} 张，未返回地址 ${result.images.missingLinks} 张；本地图片约 ${(result.images.bytes/1024/1024).toFixed(2)} MiB。`);
 for(const warning of result.detailWarnings||[])console.log('注意：'+conciseError(warning,o));
 if(o.syncOnly){o.syncBilling={estimatedCredits:estimate,initialBalance,finalBalance:!o.offline?balance():null,unknownRequests};require('./database-sync').finishSync(o,dir,[{kind:'user-posts',...result,apiCalls:result.apiCalls+detailCalls,cachedCalls:result.cachedCalls+(result.detailCached||0),newFetched:result.newFetched+detailRecords}],label,beforeKeys);}else require('./events').emit('summary',{written:writtenFile?1:0,apiCalls:result.apiCalls+detailCalls,newRecords:result.newFetched+detailRecords,cachedCalls:result.cachedCalls+(result.detailCached||0),incomplete:!result.complete,records:result.rows.length});
 require('./events').emit('credits',{estimatedCredits:estimate,unknownRequests,returnedRecords:result.newFetched+detailRecords,finished:true,initialBalance:null,finalBalance:null,offline:!!o.offline});
 if(writtenFile)reportShortcut(writtenFile,o);
 if(result.failed)process.exitCode=1;return {options:o,result,folder:dir};
}
module.exports={postsOptions,checkPostsMetadata,postsCacheFile,getUserPostsPage,safePostId,normalizeUserPost,mergePostDetail,timelineCursor,harvestUserPosts,fillPostDetails,knownPostsAccount,runUserPosts};
