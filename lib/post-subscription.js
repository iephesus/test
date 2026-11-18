'use strict';
// Subscribe to a post's chronologically returned top-level comment stream.
// Nested replies are saved when returned, never claimed to be independently polled.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {storagePaths,findPostFolder,getOne}=require('./storage'),{postPageRows}=require('./post-comments');
const {rawArray,sortRecords}=require('./core'),{stateFile,readState,withLock,harvestUpdates}=require('./incremental');
const progress=require('./update-progress');
function verifiedBaseline(dir,id,state){
 if(state?.uid!==id||state.kind!=='post-comments'||!state.baselinePacket||state.pending&&state.pending.head!==state.anchor)return null;
 const ref=state.baselinePacket,packet=require('./incremental').restorePacket(ref,dir),box=JSON.parse(require('./regular-file').read(packet.file)),q=box.query;
 if(box.schema!==1||q?.uid!==id||q.kind!=='post-comments'||!Number.isSafeInteger(q.count)||q.count<1||q.count>100||q.maxId!==''||q.sinceId!==''||q.page!==1||!/^[a-f0-9-]{36}$/.test(q.taskId||'')||require('./core').apiError(packet.raw))return null;
 const original=require('./request-journal').recover(dir,q);if(!original||original.responseHash!==ref.hash||path.resolve(original.file)!==path.resolve(packet.file))return null;
 const parsed=postPageRows(packet.raw,id);if(parsed.items.length>q.count||parsed.items.some((item,i)=>i&&BigInt(item.idstr??item.id)>=BigInt(parsed.items[i-1].idstr??parsed.items[i-1].id))||parsed.rows.some(row=>!require('./record-body').completeBody(row)))return null;
 if(parsed.items.length)return String(parsed.items[0].idstr??parsed.items[0].id)===state.anchor?{id:state.anchor,ref}:null;
 return state.anchor==='0'&&JSON.stringify(state.verifiedEmptyBaseline)===JSON.stringify(ref)&&!Number(parsed.container.total_number??parsed.container.total)&&require('./history').historyNext(packet.raw,'post-comments')==='0'?{id:'0',ref}:null;
}
function latest(base,id){
 try{
  const dir=findPostFolder(storagePaths(base).postComments,id);
  return fs.existsSync(dir)?require('./post-display-index').create(dir,id).latestComment():null;
 }catch{return null;}
}
function bootstrap(o,dir,fetch=getOne){return withLock(dir,'post-comments',()=>{
 if(readState(dir,'post-comments',o.uid))return null;
 const recovery=o.autoGuard?.job?.automaticRecovery?.kinds?.includes('post-comments');
 const file=path.join(dir,recovery?'cache/updates/post-subscription-initial/'+o.autoGuard.job.id+'.json':'cache/updates/post-subscription-initial.json');let init;try{init=JSON.parse(fs.readFileSync(file));}catch{}
 if(!init||init.postId!==o.postId){
  const count=o.autoGuard.maxCount('post-comments',recovery?1:o.count);if(!count)throw require('./auto-follow-budget').safety(o.autoGuard.stopCode,o.autoGuard.stopReason);
  init={schema:1,postId:o.postId,taskId:crypto.randomUUID(),count};progress.atomic(file,init);
 }
 const requested=init.count??1;
 if(!Number.isSafeInteger(requested)||requested<1||requested>100)throw require('./auto-follow-budget').safety('REQUEST_EVIDENCE_INVALID','首次订阅的原始请求条数无效');
 const packet=fetch({...o,dataTaskId:init.taskId,refresh:true},dir,'post-comments',requested,'','');
 const parsed=postPageRows(packet.raw,o.postId),items=parsed.items;
 if(items.length>requested||items.some((item,i)=>i&&BigInt(item.idstr??item.id)>=BigInt(items[i-1].idstr??items[i-1].id)))throw require('./auto-follow-budget').safety('AUTO_RESPONSE_INVALID','首次订阅响应数量或顺序无效，已保存原始响应');
 for(const row of parsed.rows)if(!require('./record-body').completeBody(row))throw require('./auto-follow-budget').safety('AUTO_RESPONSE_INVALID','首次评论缺少完整正文或日期，未建立订阅起点');
 if(!items.length&&(o.initialKeys.size>0||Number(parsed.container.total_number??parsed.container.total)>0))throw require('./auto-follow-budget').safety('AUTO_BASELINE_UNKNOWN','空页与已有评论或接口总数矛盾，未建立订阅起点');
 if(!items.length&&require('./history').historyNext(packet.raw,'post-comments')!=='0')throw require('./auto-follow-budget').safety('AUTO_EMPTY_UNKNOWN','空窗口未证明当前无评论，未建立订阅起点');
 const receipt=packet.receipt?{...packet.receipt,stamp:packet.cacheTimeMs,count:requested,maxId:'',sinceId:''}:{count:requested,maxId:'',sinceId:'',file:path.relative(dir,packet.file),hash:packet.responseHash};
 const state={schema:1,uid:o.uid,kind:'post-comments',anchor:items.length?String(items[0].idstr??items[0].id):'0',checkedAt:new Date().toISOString(),endPolicyVersion:2,origin:'post-subscription-head',pending:null,historyComplete:false,baselinePacket:receipt,...(!items.length?{verifiedEmptyBaseline:receipt}:{})};
 if(!progress.commit(stateFile(dir,'post-comments'),'absent',state).ok)throw require('./auto-follow-budget').safety('PROGRESS_CONFLICT','订阅起点已变化，正文保留，未覆盖进度');
 return {kind:'post-comments',budget:o.count,rows:parsed.rows,newRows:parsed.rows.filter(r=>!o.initialKeys.has(require('./database-sync').key(r))),fetched:parsed.rows.length,newFetched:packet.cached?0:items.length,requests:1,cachedCalls:packet.cached?1:0,complete:true,reason:'已保存最新主评论并建立订阅起点；较早历史仍未核验',source:parsed.source,update:{initialized:true,caughtUp:true}};
 });}
function run(job,guard){
 const limit=Math.min(job.roundLimit,require('./auto-follow-budget').MAX_CLI_ROUND_RETURNS);
 const o=require('./options').options([job.postId||job.uid,'post-comments','--sync-only','--limit',String(limit)]);
 Object.assign(o,{uid:o.postId,update:true,quickOnly:true,autoFollow:true,autoRoundId:job.id,autoGuard:guard,syncStartedAt:new Date().toISOString()});
 const dir=findPostFolder(storagePaths().postComments,o.postId);fs.mkdirSync(dir,{recursive:true});
 const before=require('./local-database').localPostComments(o,dir).rows;o.initialKeys=new Set(before.map(require('./database-sync').key));
 const flags=require('./api').preflight(o,[{kind:'post-comments',budget:o.count}]);o.creditMeter=require('./credits').createCreditMeter(o);o.creditMeter.start();guard.configure(o.endpointMetadata,o.creditMeter.snapshot());
 let result=bootstrap(o,dir);if(!result)result=harvestUpdates(o,dir,'post-comments',o.count,flags,getOne,()=>{throw Error('订阅起点未建立');});
 const after=require('./local-database').localPostComments(o,dir).rows,added=after.filter(r=>!o.initialKeys.has(require('./database-sync').key(r))&&require('./record-body').completeBody(r));
 result.newRows=sortRecords(added);result.rows=sortRecords([...new Map([...result.rows,...added].map(r=>[r.recordId,r])).values()]);result.complete=!!result.update?.caughtUp&&!result.failed&&!result.coverageUnverified&&!(result.update?.gap?.unresolvedIds||[]).length&&!result.update?.gap?.unidentifiedMissing;
 result.reason+='；订阅检查新增主评论，并保存接口随页返回的楼中楼；旧主评论下后来的回复可能未返回';
 o.creditMeter.finish();o.uid='';const summary=require('./database-sync').finishSync(o,dir,[result],'微博 '+o.postId,o.initialKeys);if(result.failed)process.exitCode=1;return summary;
}
module.exports={run,latest,bootstrap,verifiedBaseline};
