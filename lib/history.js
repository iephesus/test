'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {ENDPOINTS,positiveId,rawArray,apiError,normalize,targetNickname,sortRecords,userId}=require('./core');
const {getOne}=require('./storage');
const {recordKey}=require('./records');
const {loadIndependentArchive,createCollectionEvidence}=require('./completeness');
const {limitLabel}=require('./limits');
const {createProgress}=require('./terminal-report');
const HISTORY_PROBE_LIMIT=80;
function historyNext(raw,kind){
 const parsed=rawArray(raw,kind),box=parsed?.container||{};
 const value=box.next_cursor_str??box.next_cursor;
 if(value==null)return null;
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('服务器续取游标超出安全整数范围');
 if(!/^\d+$/.test(String(value)))throw Error('服务器返回了无法识别的续取游标');
 return BigInt(value).toString();
}
function historyRecordId(item){
 const value=item?.idstr??item?.id??item?.mid;
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('记录 ID 超出安全整数范围，无法安全定位');
 const id=positiveId(value);if(!id)throw Error('记录缺少有效 ID，无法安全定位');return id;
}
function historyIndex(dir,kind,uid,load=true,{conservativeTerminal=false,strictHead=false,session=require('./cache-session').createCacheSession()}={}){
 const records=new Map(),ranges=[],warnings=[],sources=[],packets=new Map();let name='',revision=0,mergedAt=-1,mergedCache=[];
 function add(raw,maxId='',sinceId='',cacheTimeMs=0,trustRange=true,source=null){
  const parsed=rawArray(raw,kind);if(!parsed||apiError(raw))throw Error(apiError(raw)||'历史响应缺少记录数组');
  const upper=maxId?BigInt(maxId):null,lower=BigInt(sinceId||0),items=parsed.items;
  const ids=items.map(historyRecordId);
  if(kind==='sent'&&items.some(r=>userId(r.user)!==uid))throw Error('历史缓存作者 UID 与目标用户不匹配');
  if(ids.some((x,i)=>i>0&&BigInt(x)>BigInt(ids[i-1])))throw Error('历史响应未按 ID 倒序返回');
  if(ids.some(id=>upper!=null&&BigInt(id)>upper)){const error=Error(`接口返回 ID 超过 max_id ${maxId}，无法安全跳转`);error.code='HISTORY_MAX_BOUND';throw error;}
  if(ids.some(id=>BigInt(id)<lower)){const error=Error(`接口返回 ID 小于 since_id ${sinceId}，无法安全采用该覆盖区间`);error.code='HISTORY_SINCE_BOUND';throw error;}
  if(!name)name=targetNickname(raw,kind,uid);
  for(let i=0;i<items.length;i++){
   const old=records.get(ids[i]);
   if(!old||cacheTimeMs>=old.cacheTimeMs)records.set(ids[i],{raw:items[i],id:BigInt(ids[i]),ms:session.normalize(items[i],kind,uid).ms,cacheTimeMs});
   ranges.push({lo:BigInt(ids[i]),hi:BigInt(ids[i]),time:cacheTimeMs});
  }
  // Some received-comment responses include since_id itself. Preserve that
  // raw record, but only strictly newer IDs belong to the queried open interval.
  // A latest-record response containing only the lower anchor proves the open
  // interval empty; it must neither abort navigation nor count the anchor twice.
  const effectiveItems=items.filter((_,i)=>BigInt(ids[i])>lower);
  const next=historyNext(raw,kind);
  if(next&&next!=='0'&&upper!=null&&BigInt(next)>=upper)throw Error('服务器续取游标未向前推进');
  // Empty API windows can still point to older slots. Certify only the
  // scanned band above next_cursor, never the whole prefix down to since_id.
  let floor=next!=null?(BigInt(next)+1n>lower+1n?BigInt(next)+1n:lower+1n):ids.length?ids.reduce((a,b)=>a<BigInt(b)?a:BigInt(b),BigInt(ids[0])):null;
  if((conservativeTerminal||ids.length)&&next==='0')floor=ids.length?ids.reduce((a,b)=>a<BigInt(b)?a:BigInt(b),BigInt(ids[0])):null;
  if(trustRange&&floor!=null&&(upper==null||floor<=upper))ranges.push({lo:floor,hi:strictHead&&upper==null&&ids.length?BigInt(ids[0]):upper,time:cacheTimeMs,emptyResponse:!items.length});
  revision++;
  if(source?.file){const hash=source.responseHash||session.read(source.file).hash,ref={file:path.relative(dir,source.file),hash,maxId,sinceId,time:cacheTimeMs,trustRange};const previous=sources.find(x=>x.file===ref.file&&x.hash===hash&&x.maxId===maxId&&x.sinceId===sinceId);if(previous)previous.trustRange=previous.trustRange||trustRange;else sources.push(ref);}
  if(trustRange){const key=maxId+'/'+sinceId,list=packets.get(key)||[];list.push({raw,cacheTimeMs,source});packets.set(key,list);}
  return effectiveItems;
 }
 function merged(){
  if(mergedAt===revision)return mergedCache;
  const points=[...records.values()].map(x=>x.id).sort((a,b)=>a<b?-1:a>b?1:0);
  const hasPoint=r=>{let lo=0,hi=points.length;while(lo<hi){const m=(lo+hi)>>1;if(points[m]<r.lo)lo=m+1;else hi=m;}return lo<points.length&&(r.hi==null||points[lo]<=r.hi);};
  const consistent=ranges.filter(r=>{
   if(!r.emptyResponse||!hasPoint(r))return true;
   const warning='空区间响应与已缓存记录矛盾，未采用其覆盖区间';if(!warnings.includes(warning))warnings.push(warning);return false;
  });
  const sorted=consistent.sort((a,b)=>a.lo<b.lo?-1:a.lo>b.lo?1:0),out=[];
  for(const r of sorted){
   const last=out.at(-1);
   if(last&&(last.hi==null||r.lo<=last.hi+1n)){
    last.hi=last.hi==null||r.hi==null?null:last.hi>r.hi?last.hi:r.hi;last.time=Math.max(last.time,r.time);
   }else out.push({...r});
  }
  mergedAt=revision;mergedCache=out;return out;
 }
 function read(count,maxId='',sinceId=''){
  if(conservativeTerminal){const exact=(packets.get(maxId+'/'+sinceId)||[]).filter(p=>{const a=rawArray(p.raw,kind);return a.items.length<=count;}).sort((a,b)=>Number(historyNext(a.raw,kind)==='0')-Number(historyNext(b.raw,kind)==='0')||b.cacheTimeMs-a.cacheTimeMs)[0];if(exact)return {...exact,cached:true};}
  const ceiling=maxId?BigInt(maxId):null,floor=BigInt(sinceId||0)+1n;
  if(ceiling!=null&&ceiling<floor)return {raw:{[kind==='mentions-posts'?'statuses':'comments']:[]},cached:true,cacheTimeMs:0};
  const range=merged().find(r=>ceiling==null?r.hi==null:r.lo<=ceiling&&(r.hi==null||ceiling<=r.hi));
  if(!range){const packet=(packets.get(maxId+'/'+sinceId)||[]).filter(p=>rawArray(p.raw,kind).items.length<=count).sort((a,b)=>b.cacheTimeMs-a.cacheTimeMs)[0];return packet?{...packet,cached:true}:null;}
  const minimum=range.lo>floor?range.lo:floor;
  const selected=[...records.values()].filter(r=>r.id>=minimum&&(ceiling==null||r.id<=ceiling)).sort((a,b)=>a.id>b.id?-1:a.id<b.id?1:0).slice(0,count);
  const continuation=selected.length>=count?(selected.at(-1).id-1n).toString():(minimum-1n).toString();
  return {raw:{[kind==='mentions-posts'?'statuses':'comments']:selected.map(r=>r.raw),next_cursor_str:continuation},cached:true,cacheTimeMs:range.time};
 }
 if(load&&fs.existsSync(path.join(dir,'cache'))){
  for(const filename of fs.readdirSync(path.join(dir,'cache'))){
   const match=filename.match(new RegExp('^'+kind+'_c(\\d+)_m(\\d+)(?:_s(\\d+))?(_legacy_[a-f0-9]{16})?\\.json$'));
   if(!match&&filename!==kind+'_page1.json')continue;
   const file=path.join(dir,'cache',filename),maxId=match?.[2]==='0'?'':match?.[2]||'',sinceId=match?.[3]||'';
   try{
    const entry=session.read(file),raw=entry.raw,mtime=entry.stamp;
    try{add(raw,maxId,sinceId,mtime,!match?.[4],{file,responseHash:entry.hash});}catch(error){
     if(kind==='received'&&error.code==='HISTORY_SINCE_BOUND'){
      // The saved response is still real data, but an ignored lower bound
      // cannot certify any interval. Retain points, then verify with max_id only.
      add(raw,maxId,'',mtime,false,{file});
      warnings.push(filename+'：旧 since_id 响应只保留记录，不采用覆盖区间');
     }else throw error;
    }
   }catch(error){warnings.push(filename+'：未采用异常缓存（原文件保留）：'+error.message);}
  }
 }
 if(load)for(const p of require('./exchange-records').packets(dir,kind,uid))try{add(p.raw,p.query.maxId,p.query.sinceId,p.cacheTimeMs,rawArray(p.raw,kind).items.length>0||!!historyNext(p.raw,kind)&&historyNext(p.raw,kind)!=='0',{file:p.file,responseHash:p.hash});}catch(error){warnings.push('导入区间未采用：'+error.message);}
 const initialBands=load?merged().map(r=>({...r})):[];
 return {strictHead,add,read,records,kind,warnings,sources,session,requestCount(count,max=''){if(!max||count<=1)return count;const ceiling=BigInt(max);return initialBands.some(r=>r.hi!=null&&r.hi<ceiling)?1:count;},get name(){return name;}};
}
function historyCandidate(index,beforeMs,lo,hi,step){
 const known=[...index.records.values()].filter(r=>Number.isFinite(r.ms)).sort((a,b)=>a.ms-b.ms);
 const first=known[0],last=known.at(-1);
 const middle=(lo+hi)/2n;
 // A fitted ID is only a probe proposal. It NEVER becomes the collection cursor
 // without an API/cache interval proving which record immediately precedes the cutoff.
 if(step<8&&first&&last&&last.ms>first.ms&&last.id>first.id){
  const scale=(last.id-first.id),span=BigInt(last.ms-first.ms);
  let estimate=first.id+scale*BigInt(Math.trunc(beforeMs+60000-first.ms))/span;
  if(estimate<=lo){
   const expansion=scale*BigInt(3600000*2**Math.min(step,7))/span;
   estimate=lo+(expansion>0n?expansion:1n);
  }
  if(estimate>lo&&estimate<hi)return estimate;
 }
 return middle;
}
function seekHistoryBoundary(index,beforeMs,read){
 function facts(){
  const values=[...index.records.values()].filter(r=>Number.isFinite(r.ms));
  const old=values.filter(r=>r.ms<=beforeMs).sort((a,b)=>a.id>b.id?-1:a.id<b.id?1:0)[0];
  const newer=values.filter(r=>r.ms>beforeMs).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)[0];
  if(old&&newer&&old.id>=newer.id)throw Error('记录 ID 与日期顺序冲突，无法安全定位，完整性未确认');
  return {old,newer};
 }
 function classify(packet){
  const item=Array.isArray(packet.items)?packet.items[0]:rawArray(packet.raw,index.kind)?.items?.[0];
  if(!item)return null;
  const id=BigInt(historyRecordId(item)),value=index.records.get(id.toString());
  if(!Number.isFinite(value?.ms))throw Error(`定位记录 ${id} 时间无法识别，无法安全跳过该边界`);
  return value;
 }
 let {old,newer}=facts();
 if(!newer){
  const head=classify(read(1,'','','seek'));
  if(!head)return null;
  if(head.ms<=beforeMs)return head.raw;
  ({old,newer}=facts());
 }
 let lo=old?.id||0n,hi=newer.id,lastCheck=null;
 function certify(cacheOnly=false){
  const max=(hi-1n).toString(),since='';
  // Resolve scanned windows to the actual visible predecessor; an empty
  // window with a continuation is never an empty-prefix certificate.
  if(cacheOnly){
   let cursor=max,available=false;const seen=new Set();
   for(;;){
    const local=index.read(1,cursor,since);if(!local)break;
    const next=historyNext(local.raw,index.kind);
    if(rawArray(local.raw,index.kind).items.length||next==='0'){available=true;break;}
    if(next==null||seen.has(next))break;seen.add(next);cursor=next;
   }
   if(!available)return null;
  }
  const packet=read(1,max,since,'seek'),previous=classify(packet);
  if(!previous){
   const rawCount=rawArray(packet.raw,index.kind)?.items.length||0;
   if(old&&!packet.cached&&!packet.transmittedSince&&!rawCount)throw Error('接口空页与已缓存的较早评论矛盾，日期边界尚未核实');
   return {done:true,value:old?.raw||null};
  }
  if(previous.ms<=beforeMs){
   if(old&&previous.id<old.id)throw Error('服务器窗口与已缓存的较新匹配记录矛盾，日期边界尚未核实');
   return {done:true,value:previous.raw};
  }
  if(previous.id<=lo)throw Error('历史区间证据相互矛盾，日期边界尚未核实');
  hi=previous.id;
  lastCheck={hi,old:old?.id||0n,span:hi-lo};
  return {done:false};
 }
 for(let step=0;;step++){
  ({old,newer}=facts());
  if(old&&old.id>lo)lo=old.id;
  if(newer.id<hi)hi=newer.id;
  const cached=certify(true);
  if(cached?.done)return cached.value;
  if(hi<=lo)throw Error('历史区间证据相互矛盾，日期边界尚未核实');
  if(hi-lo<=1n)return old?.raw||null;
  if(old&&!lastCheck&&newer.ms-beforeMs<=86400000){
   const checked=certify();if(checked.done)return checked.value;
  }
  const candidate=historyCandidate(index,beforeMs,lo,hi,step);
  const probe=read(1,candidate.toString(),'','seek'),r=classify(probe);
  if(!r||r.ms<=beforeMs)lo=candidate;else hi=r.id;
  ({old}=facts());
  // Recheck whenever a bound improves, or after two bisection reductions.
  // In particular, do not keep halving an empty 16-digit ID gap down to 1
  // after the first two predecessor checks have already been used.
  const improved=!lastCheck||hi<lastCheck.hi||(old?.id||0n)>lastCheck.old;
  const contracted=lastCheck&&hi-lo<=lastCheck.span/4n;
  if(improved||contracted){
   const checked=certify();if(checked.done)return checked.value;
  }
 }
}
function harvestBefore(opts,dir,kind,budget,fetchPage=getOne){
 const out={kind,budget,rows:[],fetched:0,newFetched:0,requests:0,cachedCalls:0,cacheTimes:[],name:'',reason:'',beforeMs:opts.beforeMs,apiLimit:opts.offline?0:opts.pages,scanned:0,skippedNewer:0,unknownTimeIds:[],cacheWarnings:[],ended:false,located:false,partial:false,seekApiCalls:0,seekRecords:0,collectionApiCalls:0};
 if(budget<=0){out.reason='此分类分配 0 条';return out;}
 const session=require('./cache-session').createCacheSession();opts={...opts,cacheSession:session};
 const archive=loadIndependentArchive(dir,kind,opts.uid,session),evidence=createCollectionEvidence(dir,kind,opts.uid);
 const progress=createProgress(opts);
 const selected=new Map(),seen=new Set();let index,verifyEnd=false;
 function readPage(count,maxId='',sinceId='',phase='collect'){
  const started=Date.now(),apiSince='';
  let packet=index.read(count,maxId,sinceId);
  if(!packet){
   count=index.requestCount(count,maxId);
   if(opts.offline)throw Error('离线缓存不足，无法核实日期边界或继续采集；未取满不代表没有互动');
   if(out.requests-out.cachedCalls>=opts.pages)throw Error(`达到 --pages 新增 API 请求上限（${opts.pages} 次），${out.located?'采集尚未取满':'日期尚未定位完成'}`);
   if(phase==='seek'&&out.seekApiCalls>=(opts.seekLimit??HISTORY_PROBE_LIMIT))throw Error(`达到 --seek-limit 单条定位探测上限（${limitLabel(opts.seekLimit??HISTORY_PROBE_LIMIT)} 次），日期边界仍未核实；可增大该值或设为 all`);
   try{packet=fetchPage({...opts,refresh:true,offline:false},dir,kind,count,maxId,apiSince);}catch(error){const failure=require('./collection-failure').accountFailure(out,error);if(failure.apiCalls){if(phase==='seek'){out.seekApiCalls++;out.seekRecords+=failure.returnedRecords;}else out.collectionApiCalls++;}out.failed=true;throw Error('请求失败：'+error.message);}
   if(!packet)throw Error('请求失败：未返回有效历史响应');
  }
  out.requests++;if(packet.cached)out.cachedCalls++;
  if(packet.cached&&Number.isFinite(packet.cacheTimeMs)&&packet.cacheTimeMs>0)out.cacheTimes.push(packet.cacheTimeMs);
  const parsed=rawArray(packet.raw,kind);if(!parsed||apiError(packet.raw))throw Error('请求失败：'+(apiError(packet.raw)||'历史响应缺少记录数组'));
  if(!packet.cached){
   out.newFetched+=parsed.items.length;
   if(phase==='seek'){out.seekApiCalls++;out.seekRecords+=parsed.items.length;}else out.collectionApiCalls++;
  }
  evidence.add(packet,count,maxId,phase==='seek'?'seek':'collect');
  const effective=index.add(packet.raw,maxId,packet.cached?sinceId:apiSince,packet.cacheTimeMs||Date.now(),true,packet);
  packet.transmittedSince=packet.cached?'':apiSince;
  packet.items=effective.filter(item=>BigInt(historyRecordId(item))>BigInt(sinceId||0));
  packet.nextCursor=historyNext(packet.raw,kind);
  if(packet.nextCursor==null&&packet.items.length)packet.nextCursor=(BigInt(packet.items.map(historyRecordId).reduce((a,b)=>BigInt(a)<BigInt(b)?a:b,historyRecordId(packet.items[0])))-1n).toString();
  if(!out.name)out.name=index.name;
  for(const item of parsed.items){
   const row=normalize(item,kind,opts.uid),key=recordKey(row);
   if(seen.has(key))continue;seen.add(key);out.scanned++;
   if(!Number.isFinite(row.ms))out.unknownTimeIds.push(row.recordId||'ID 未返回');
   else if(row.ms>opts.beforeMs)out.skippedNewer++;
  }
  const echoes=parsed.items.length-packet.items.length;
  packet.boundaryEcho=echoes>0;
  if(!packet.cached&&phase==='collect'&&opts.noteNewRecords)opts.noteNewRecords(packet.items.map(item=>normalize(item,kind,opts.uid)).filter((row,i)=>
   !archive.records.has(row.recordId)&&row.ms<=opts.beforeMs&&row.ms>=(opts.startMs??-Infinity)&&require('./record-body').completeBody(row,packet.items[i])));
  require('./events').emit('collection',{kind,phase:phase==='seek'?'seek':'collect',fetched:selected.size,budget:phase==='seek'?null:Number.isFinite(budget)?budget:null});
  progress.update(`${opts.creditMeter?opts.creditMeter.progress()+' · ':''}${phase==='seek'?'日期定位':'采集'} · ${ENDPOINTS[kind].label} · API ${out.requests-out.cachedCalls} 次 · 已读 ${selected.size}/${limitLabel(budget)} 条`, `  ${phase==='seek'?'定位':'采集'} #${out.requests} ${ENDPOINTS[kind].command.join(' ')} --count ${count}${maxId?' --max_id '+maxId:''}${apiSince?' --since_id '+apiSince:''} | ${packet.cached?'缓存':'API'}返回 ${parsed.items.length} 条${echoes?`（本地下界排除 ${echoes} 条，不重复计数）`:''} | 定位新增返回 ${out.seekRecords} 条，采集已采用 ${selected.size} / ${limitLabel(budget)} 条 | 耗时 ${((Date.now()-started)/1000).toFixed(2)} 秒`);
  if(!packet.cached&&parsed.items.length>count)throw Error('接口返回数超过请求数量，原始响应已保存；为避免额外消耗已停止');
  return packet;
 }
 function read(count,maxId='',sinceId='',phase='collect'){
  let cursor=maxId;const visited=new Set();
  for(;;){
   const packet=readPage(count,cursor,sinceId,phase);
   if(packet.items.length)return packet;
   if(packet.nextCursor==='0'){
    if([...index.records.values()].some(item=>(!cursor||item.id<=BigInt(cursor))&&item.id>BigInt(sinceId||0)))throw Error('服务器终止游标与已缓存的较早记录矛盾，历史尚未核实');
    return packet;
   }
   if(packet.nextCursor==null)throw Error('空响应未提供 next_cursor，无法确认是否还有较早记录');
   if(visited.has(packet.nextCursor)||(cursor&&BigInt(packet.nextCursor)>=BigInt(cursor)))throw Error('服务器续取游标重复或未推进，历史尚未取完');
   visited.add(packet.nextCursor);
   progress.detail(`  空窗口仍有 next_cursor ${packet.nextCursor}，继续读取，不作为结束或日期缺口。`);
   cursor=packet.nextCursor;
  }
 }
 try{
  index=historyIndex(dir,kind,opts.uid,!opts.refresh,{session,strictHead:!!opts.syncRegular});out.name=index.name;
  out.cacheWarnings=index.warnings;
  if(index.warnings.length)progress.detail(`  兼容处理 ${index.warnings.length} 份旧探测缓存：原文件保留，未核实的覆盖区间不会沿用。`);
  progress.detail(`  本地缓存索引 ${index.records.size} 条独立记录；先核实日期边界，定位每次最多返回 1 条。`);
  const bookmarked=!opts.refresh?require('./history-bookmarks').reuseBoundary(dir,kind,opts.uid,opts.beforeMs,index):null;
  if(bookmarked?.error)progress.detail('  旧边界证明未复用：'+bookmarked.error);
  const boundary=bookmarked&&!bookmarked.error?bookmarked.boundary:seekHistoryBoundary(index,opts.beforeMs,read);
  if(bookmarked&&!bookmarked.error){out.requests++;out.cachedCalls++;out.boundaryReused=true;progress.note('  日期边界已从本地证明复用，新增定位费用 0 credits。');}
  if(!opts.offline)require('./history-bookmarks').saveBoundary(dir,kind,opts.uid,opts.beforeMs,boundary,index);
  out.located=true;
  if(!boundary){out.ended=true;out.reason='已核实接口当前可见范围内没有截止日期前的记录';}
  else{
   const seed=normalize(boundary,kind,opts.uid);if(seed.ms>=(opts.startMs??-Infinity)&&(!opts.syncRegular||require('./record-body').completeBody(seed,boundary)))selected.set(recordKey(seed),seed);else if(seed.ms<(opts.startMs??-Infinity)){out.ended=true;out.rangeComplete=true;out.reason='已核实所选日期范围内没有可见记录';}
   progress.note(`  已定位：${seed.time}，${Number.isFinite(budget)?`开始正常采集截止日期前的 ${budget} 条。`:'开始读取截止日期前的全部可见记录。'}`);
   let cursor=(BigInt(seed.recordId)-1n).toString();
   while(!out.rangeComplete&&selected.size<budget&&BigInt(cursor)>0n){
    const packet=read(Math.min(opts.pageSize,budget-selected.size,verifyEnd?1:Infinity),cursor,'','collect');
    if(!packet.items.length){out.ended=true;out.reason='接口返回空页，已到当前可见历史末尾';break;}
    let added=0;
    for(const item of packet.items){
     const row=normalize(item,kind,opts.uid);
     if(!Number.isFinite(row.ms))continue;
     if(row.ms>opts.beforeMs)throw Error('已定位区间返回了更晚日期的记录，日期与 ID 顺序不一致，完整性未确认');
     if(row.ms<(opts.startMs??-Infinity)){out.rangeComplete=true;continue;}
     if(opts.syncRegular&&!require('./record-body').completeBody(row,item)){out.coverageUnverified=true;continue;}
     if(!selected.has(recordKey(row))){selected.set(recordKey(row),row);added++;}
    }
    if(out.rangeComplete){out.ended=true;out.reason='已读取至起始日期，所选日期范围采集结束（仅限当前可见记录）';break;}
    const next=packet.nextCursor;
    if(next==='0'){const low=packet.items.map(historyRecordId).reduce((a,b)=>BigInt(a)<BigInt(b)?a:b);if(BigInt(low)<=1n){out.ended=true;break;}cursor=(BigInt(low)-1n).toString();verifyEnd=!verifyEnd;continue;}else verifyEnd=false;
    if(!added&&packet.items.every(item=>Number.isFinite(normalize(item,kind,opts.uid).ms)))throw Error('接口重复返回相同记录，无法安全继续采集');
    if(BigInt(next)>=BigInt(cursor))throw Error('分页游标未向前推进，无法安全继续采集');
    cursor=next;
   }
   if(selected.size>=budget)out.reason='已取得截止日期前的目标条数（仅限接口当前可见范围）';
   else if(!out.reason)out.reason='ID 已无法继续向前，未核实更早历史';
  }
 }catch(error){out.reason=error.message;}
 if(!out.located&&index){
  for(const value of index.records.values()){
   const row=normalize(value.raw,kind,opts.uid);
   if(Number.isFinite(row.ms)&&row.ms<=opts.beforeMs&&row.ms>=(opts.startMs??-Infinity))selected.set(recordKey(row),row);
  }
  if(selected.size){out.partial=true;out.reason+='；仅展示已取得片段，尚未确认截止日期前最近的目标条数';}
 }
 if(out.located&&!opts.offline){const seed=[...selected.values()].sort((a,b)=>b.ms-a.ms)[0];if(seed){const raw=index.records.get(seed.recordId)?.raw;if(raw)require('./history-bookmarks').saveBoundary(dir,kind,opts.uid,opts.beforeMs,raw,index);}}
 progress.end();out.rows=sortRecords([...selected.values()]).slice(0,budget);out.fetched=out.rows.length;
 if(out.unknownTimeIds.length){out.coverageUnverified=true;out.reason+=`；${out.unknownTimeIds.length} 条时间无法识别，完整性未确认`;}
 return evidence.finish(out,archive,opts);
}

module.exports={harvestBefore,historyIndex,historyNext,historyRecordId,HISTORY_PROBE_LIMIT,seekHistoryBoundary};
