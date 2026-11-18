'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');

const {ENDPOINTS,BASE,text,positiveId,userId,userName,hasBefore,rawArray,apiError,executionFailed,unverifiedBilling,runCli,safeName}=require('./core');
function indexRead(root){try {const o=require('./file-view-cache').readJSON(path.join(root,'.account_names.json'));return o&&typeof o==='object'&&!Array.isArray(o)?o:{}}catch{return {}}}
function mappedFolder(root,uid,index){const n=index[uid]?.folder;
 if(typeof n==='string'&&n!=='.'&&n!=='..'&&!/[\\/]/.test(n)&&fs.existsSync(path.join(root,n)))return path.join(root,n);
 return path.join(root,uid);
}
function validateLegacyControl(base=BASE){
 if(require('./data-layout').separated(base))return;
 const file=path.join(base,'data/.account_names.json');if(!fs.existsSync(file))return;
 const index=require('./file-view-cache').readJSON(file);if(!index||typeof index!=='object'||Array.isArray(index))throw Error('旧账号映射格式无效，原文件保留');
 if(Object.entries(index).some(([uid,value])=>/^\d{5,20}$/.test(uid)&&value?.folder==='.reader'))throw Object.assign(Error('旧账号映射将 .reader 明确指定为用户目录，与应用控制目录冲突；原映射和正文已保留，需先安全整理旧目录'),{code:'LOCAL_SOURCE_INVALID'});
}
function reportBase(dir){return require('./exchange-store').baseFor(dir,true);}
function folderPinned(base,dir){const folder=require('./data-layout').reportPath(dir,base),normalize=require('./report-catalog').normalizeId,prefix=normalize(path.relative(path.join(base,'output'),folder))+'/';return require('./report-lifecycle').pins(base).some(p=>normalize(p.id).startsWith(prefix));}
function commitName(root,uid,start,index,newName){const base=reportBase(start);return base?require('./report-lifecycle').locked(base,()=>commitNameUnlocked(root,uid,start,index,newName,base)):commitNameUnlocked(root,uid,start,index,newName,null);}
function commitNameUnlocked(root,uid,start,index,newName,base){const name=text(newName||index[uid]?.nickname||'').trim();const safe=safeName(name);
 if(!safe)return {folder:start,label:uid};
 if(base&&folderPinned(base,start)){index[uid]={folder:path.basename(start),nickname:name};require('./update-progress').atomic(path.join(root,'.account_names.json'),index);return {folder:start,label:name};}
 let destName=safe;
 const ownedOther=x=>Object.entries(index).some(([id,e])=>id!==uid&&e?.folder===x);
 const clash=x=>ownedOther(x)||(path.resolve(path.join(root,x))!==path.resolve(start)&&fs.existsSync(path.join(root,x)));
 if(clash(destName))destName=`${[...safe].slice(0,48).join('')}_${uid}`;
 if(clash(destName)){return {folder:start,label:name};}
 const dest=path.join(root,destName);
 if(path.resolve(start)!==path.resolve(dest)){
  const a=require('./data-layout').reportPath(start,base||BASE),b=require('./data-layout').reportPath(dest,base||BASE),relocate=base?require('./report-catalog').relocation(base,a):()=>{};if(a!==start&&a!==b&&fs.existsSync(a))mergeStoredPath(a,b,{moves:[],conflicts:[],duplicates:0});
  fs.renameSync(start,dest);relocate(b);
 }
 index[uid]={folder:destName,nickname:name};
 fs.writeFileSync(path.join(root,'.account_names.json'),JSON.stringify(index,null,2)+'\n');
 return {folder:dest,label:name};
}
function storagePaths(base=BASE){
 const output=path.join(base,'output'),data=require('./data-layout').separated(base)?path.join(base,'data'):output,users=path.join(data,'user-comments');
 return {output,users,userComments:users,data,postComments:path.join(data,'post-comments'),posts:path.join(data,'posts'),legacy:path.join(base,'data'),oldUsers:path.join(output,'users')};
}
function folderComponent(value){return typeof value==='string'&&value!=='.'&&value!=='..'&&value.length>0&&!/[\\/\u0000]/.test(value);}
function mergeStoredPath(source,dest,report){
 if(path.resolve(source)===path.resolve(dest))return dest;
 const stat=fs.lstatSync(source);if(stat.isSymbolicLink())throw Error('迁移遇到符号链接，请保留并单独检查：'+source);
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 if(!fs.existsSync(dest)){fs.renameSync(source,dest);report.moves.push({from:source,to:dest});return dest;}
 const target=fs.lstatSync(dest);if(target.isSymbolicLink())throw Error('迁移目标是符号链接：'+dest);
 if(stat.isDirectory()&&target.isDirectory()){
  for(const name of fs.readdirSync(source))mergeStoredPath(path.join(source,name),path.join(dest,name),report);
  fs.rmdirSync(source);return dest;
 }
 if(!stat.isFile()||!target.isFile())throw Error('迁移目标类型冲突，原文件已保留：'+dest);
 const bytes=fs.readFileSync(source);
 if(bytes.equals(fs.readFileSync(dest))){fs.unlinkSync(source);report.duplicates++;return dest;}
 const hash=crypto.createHash('sha256').update(bytes).digest('hex').slice(0,12),ext=path.extname(dest);
 let alternate=dest.slice(0,dest.length-ext.length)+'_legacy_'+hash+ext;
 if(fs.existsSync(alternate)&&!bytes.equals(fs.readFileSync(alternate)))alternate=dest.slice(0,dest.length-ext.length)+'_legacy_'+crypto.randomUUID()+ext;
 if(fs.existsSync(alternate)){fs.unlinkSync(source);report.duplicates++;}else fs.renameSync(source,alternate);
 report.conflicts.push({from:source,to:alternate});return alternate;
}
function postIdFromFolder(name){return /^\d{5,20}$/.test(name)?name:name.match(/_(\d{5,20})$/)?.[1]||'';}
function postSourceFromFolder(dir,postId){
 const cache=path.join(dir,'cache');if(!fs.existsSync(cache))return {};
 const files=require('./regular-file').list(cache,/^post-comments_.*\.json$/).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
 for(const file of files){
  try{
   const raw=require('./cache-session').createCacheSession({maxBytes:0}).read(file).raw;if(apiError(raw))continue;
   const parsed=rawArray(raw,'post-comments');
   const candidates=[raw?.status,raw?.weibo,raw?.data?.status,raw?.data?.weibo,...(parsed?.items||[]).flatMap(c=>[c.status,c.weibo])];
   for(const post of candidates)if(positiveId(post?.idstr,post?.id,post?.mid)===postId&&userName(post.user))return post;
  }catch(error){if(error.code==='LOCAL_SOURCE_INVALID')throw error;}
 }
 for(const e of require('./exchange-records').iterateEntries(dir)){const v=e.value;if(v.role!=='packet'||v.owner?.kind!=='post'||v.owner.id!==postId)continue;const a=rawArray(v.response,'post-comments');for(const post of [v.response.status,v.response.weibo,...(a?.items||[]).flatMap(c=>[c.status,c.weibo])])if(positiveId(post?.idstr,post?.id,post?.mid)===postId&&userName(post.user))return post;}
 return {};
}
function findPostFolder(posts,postId){
 if(!fs.existsSync(posts))return path.join(posts,postId);
 const names=fs.readdirSync(posts,{withFileTypes:true}).filter(e=>e.isDirectory()&&postIdFromFolder(e.name)===postId).map(e=>e.name);
 if(names.length>1)throw Error('同一微博存在多个输出目录，请先合并：'+postId);
 return path.join(posts,names[0]||postId);
}
function commitPostFolder(posts,postId,start,source={},report={moves:[],conflicts:[],duplicates:0}){const base=reportBase(start);return base?require('./report-lifecycle').locked(base,()=>commitPostFolderUnlocked(posts,postId,start,source,report,base)):commitPostFolderUnlocked(posts,postId,start,source,report,null);}
function commitPostFolderUnlocked(posts,postId,start,source,report,base){
 if(base&&folderPinned(base,start))return start;
 const nickname=safeName(userName(source.user));let name;
 if(nickname)name=`${nickname}_${postId}`;
 else if(path.basename(start).endsWith('_'+postId))name=path.basename(start);
 else name=`${userId(source.user)?'用户'+userId(source.user):'未知作者'}_${postId}`;
 const dest=path.join(posts,name);fs.mkdirSync(start,{recursive:true});if(path.resolve(start)===path.resolve(dest))return dest;
 const from=require('./data-layout').reportPath(start,base||BASE),to=require('./data-layout').reportPath(dest,base||BASE),relocate=base?require('./report-catalog').relocation(base,from):()=>{};
 if(from!==start&&from!==to&&fs.existsSync(from))mergeStoredPath(from,to,report);mergeStoredPath(start,dest,report);relocate(to);return dest;
}
function prepareOutputLayout(base=BASE){validateLegacyControl(base);if(require('./data-layout').separated(base))return {...storagePaths(base),moves:[],conflicts:[],duplicates:0,rewrittenLinks:0};return require('./report-lifecycle').locked(base,()=>prepareOutputLayoutUnlocked(base));}
function prepareOutputLayoutUnlocked(base){
 if(require('./data-layout').separated(base))return {...storagePaths(base),moves:[],conflicts:[],duplicates:0,rewrittenLinks:0};
 const paths=storagePaths(base),report={moves:[],conflicts:[],duplicates:0,rewrittenLinks:0};
 const readIndex=dir=>{
  const file=path.join(dir,'.account_names.json');if(!fs.existsSync(file))return {};
  const value=require('./file-view-cache').readJSON(file);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('账号映射格式无效，已保留原文件：'+file);return value;
 };
 // Validate every mapping before moving anything.
 const needsLinkRepair=fs.existsSync(paths.legacy)&&fs.readdirSync(paths.legacy).some(name=>name!=='.reader')||fs.existsSync(paths.oldUsers);
 let current=readIndex(paths.users);const sources=[paths.legacy,paths.oldUsers].map(dir=>({dir,index:readIndex(dir)}));readIndex(paths.posts);
 fs.mkdirSync(paths.users,{recursive:true});fs.mkdirSync(paths.postComments,{recursive:true});fs.mkdirSync(paths.posts,{recursive:true});
 for(const {dir,index} of sources){
  if(!fs.existsSync(dir))continue;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   if(entry.name==='.account_names.json'||dir===paths.legacy&&entry.name==='.reader')continue;
   const source=path.join(dir,entry.name);
   if(dir===paths.legacy&&entry.name==='posts'&&entry.isDirectory()){mergeStoredPath(source,paths.postComments,report);continue;}
   let name=entry.name;
   if(entry.isDirectory()){
    const owner=Object.keys(index).find(uid=>index[uid]?.folder===entry.name)||(/^\d{5,20}$/.test(entry.name)?entry.name:'');
    const desired=current[owner]?.folder;
    if(owner&&folderComponent(desired))name=desired;
    else if(owner&&(Object.entries(current).some(([uid,e])=>uid!==owner&&e?.folder===name)||fs.existsSync(path.join(paths.users,name)))){
     let suffix=0;do{name=`${safeName(entry.name)}_${owner}${suffix?'_'+suffix:''}`;suffix++;}while(fs.existsSync(path.join(paths.users,name))||Object.entries(current).some(([uid,e])=>uid!==owner&&e?.folder===name));
    }
    if(owner&&(index[owner]||current[owner]))current[owner]={...index[owner],...current[owner],folder:name};
   }
   mergeStoredPath(source,path.join(paths.users,name),report);
  }
  const oldFile=path.join(dir,'.account_names.json');
  if(fs.existsSync(oldFile)){fs.writeFileSync(path.join(paths.users,'.account_names.json'),JSON.stringify(current,null,2)+'\n');fs.unlinkSync(oldFile);}
  if(!fs.readdirSync(dir).length)fs.rmdirSync(dir);
 }
 // The previous output/posts contained post-comment exports. Only move positively identified folders.
 for(const entry of fs.readdirSync(paths.posts,{withFileTypes:true})){
  if(!entry.isDirectory()||!postIdFromFolder(entry.name))continue;
  const source=path.join(paths.posts,entry.name),cache=path.join(source,'cache');
  const identified=(fs.existsSync(cache)&&fs.readdirSync(cache).some(name=>/^post-comments_.*\.json$/.test(name)))||fs.readdirSync(source).some(name=>/_微博下的评论_.*\.html$/.test(name));
  if(identified)mergeStoredPath(source,path.join(paths.postComments,entry.name),report);
 }
 const groups=new Map();
 for(const entry of fs.readdirSync(paths.postComments,{withFileTypes:true})){
  const id=entry.isDirectory()?postIdFromFolder(entry.name):'';if(!id)continue;
  if(!groups.has(id))groups.set(id,[]);groups.get(id).push(path.join(paths.postComments,entry.name));
 }
 for(const [id,dirs]of groups){
  if(dirs.some(dir=>folderPinned(base,dir)))continue;
  if(dirs.length===1&&path.basename(dirs[0])!==id)continue;
  const source=dirs.map(dir=>postSourceFromFolder(dir,id)).find(item=>userName(item.user))||{};
  const dest=commitPostFolder(paths.postComments,id,dirs[0],source,report);
  for(const dir of dirs.slice(1))if(fs.existsSync(dir)&&path.resolve(dir)!==path.resolve(dest))mergeStoredPath(dir,dest,report);
 }
 // Repair absolute local links left in older diagnostic reports, without touching raw JSON.
 const replacements=[[path.join(paths.output,'users')+'/',paths.users+'/']];
 const walk=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,item.name);if(item.isDirectory()){walk(file);continue;}if(!item.name.endsWith('.html'))continue;
  const original=require('./regular-file').read(file).toString('utf8');let updated=original;
  for(const [from,to] of replacements)updated=updated.replace(/href=("|')([^"']*)\1/g,(full,quote,url)=>url.includes(from)?'href='+quote+url.split(from).join(to)+quote:full);
  if(updated!==original){fs.writeFileSync(file,updated);report.rewrittenLinks++;}
 }};
 if(needsLinkRepair){walk(paths.users);walk(paths.postComments);}return {...paths,...report};
}

function legacy(dir,uid,kind,count,maxId){
 if(maxId||count!==50)return null;
 const f=path.join(dir,'cache',kind+'_page1.json');if(fs.existsSync(f))return f;
 if(kind==='sent'){
   const g=path.join(storagePaths().users,uid+'_page1.json');if(fs.existsSync(g))return g;
 }
 return null;
}
function cacheFile(dir,kind,count,maxId,sinceId='',page=1){return path.join(dir,'cache',`${kind}_c${count}_m${maxId||'0'}${sinceId?'_s'+sinceId:''}${page>1?'_p'+page:''}.json`);}
function getOne(opts,dir,kind,count,maxId,sinceId=''){
 const page=kind==='post-comments'?(opts.postPage||1):1;
 const cache=cacheFile(dir,kind,count,maxId,sinceId,page);
 const journal=require('./request-journal'),query={uid:opts.uid||opts.postId,kind,count,maxId,sinceId,page,taskId:opts.dataTaskId||''},recovered=journal.recover(dir,query);
 if(recovered&&!recovered.receivedResponse){
  // A complete response may have committed before its request status or unread
  // side effects. Preserve the original post replay guarantee before returning.
  if(kind==='post-comments'){const base=require('./exchange-store').baseFor(dir);require('./post-reading-state').start(base,opts.postId);require('./post-reading-state').recover(base,opts.postId);}
  return recovered;
 }
 if(!recovered&&!opts.refresh&&!sinceId){const packet=require('./exchange-records').packets(dir,kind,opts.postId||opts.uid).filter(p=>p.query.count===count&&p.query.maxId===(maxId||'')&&!p.query.sinceId&&p.query.page===page).sort((a,b)=>b.cacheTimeMs-a.cacheTimeMs)[0];if(packet)return packet;}
 if(!recovered&&sinceId&&!opts.refresh)throw Error('带 since_id 的探测应通过历史区间索引复用，不能混用普通缓存');
 let source=!recovered&&!opts.refresh?(fs.existsSync(cache)?cache:legacy(dir,opts.uid,kind,count,maxId)):null;
 // A previously cached larger first-page response can satisfy a smaller count at zero cost.
 // For an actual new request we always pass the desired count, never trim a paid oversized response.
 if(!recovered&&!source&&!opts.refresh&&page===1){
   const cacheDir=path.join(dir,'cache');
   if(fs.existsSync(cacheDir)){
     const token=maxId||'0';
     const candidates=fs.readdirSync(cacheDir).map(f=>{
       const m=f.match(new RegExp('^'+kind.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'_c(\\d+)_m'+token+'\\.json$'));
       return m?{file:path.join(cacheDir,f),size:Number(m[1])}:null;
     }).filter(x=>x).sort((a,b)=>{
       const fullA=a.size>=count,fullB=b.size>=count;
       return fullA!==fullB?(fullA?-1:1):fullA?a.size-b.size:b.size-a.size;
     });
     if(candidates.length)source=candidates[0].file;
   }
 }
 // Historical scans can continue from a short but contiguous dedicated cache page.
 if(!recovered&&!source&&!opts.refresh&&!maxId&&hasBefore(opts)){
   const old=path.join(dir,'cache',kind+'_page1.json');if(fs.existsSync(old))source=old;
 }
 // Reuse existing larger legacy first-page JSON for sent, if present.
 if(!recovered&&!source&&!opts.refresh&&!maxId&&kind==='sent'){
   for(const f of [path.join(dir,'cache','sent_page1.json'),path.join(storagePaths().users,opts.uid+'_page1.json')]){
     if(!fs.existsSync(f))continue;
     try{const old=JSON.parse(fs.readFileSync(f,'utf8'));
       if(!apiError(old)&&((rawArray(old,kind)?.items?.length??0)>=count||hasBefore(opts))){source=f;break;}
     }catch{}
   }
 }
 // A previously retrieved mixed-timeline page may already contain enough
 // records of a direction. Read-only reuse, NOT a new paid request.
 // Reuse only if there are at least `count` identifiable records for the
 // requested direction; otherwise query that direction's dedicated API.
 if(!recovered&&!source&&!opts.refresh&&!maxId&&!hasBefore(opts)&&Number.isFinite(opts.count)&&(kind==='sent'||kind==='received')){
   const cacheDir=path.join(dir,'cache');
   if(fs.existsSync(cacheDir)){
     const mixed=fs.readdirSync(cacheDir)
       .filter(f=>/^both_c\d+_m0\.json$/.test(f))
       .sort((a,b)=>Number(b.match(/_c(\d+)_/)[1])-Number(a.match(/_c(\d+)_/)[1]));
     for(const filename of mixed){
       try{const old=JSON.parse(fs.readFileSync(path.join(cacheDir,filename),'utf8'));
         if(apiError(old))continue;
         const a=rawArray(old,'both')?.items??[];
         const selected=a.filter(c=>{
           const writer=userId(c?.user)===opts.uid;
           const owner=userId((c?.status??c?.weibo)?.user)===opts.uid||userId(c?.reply_comment?.user)===opts.uid||userId(c?.reply_user)===opts.uid;
           return kind==='sent'?writer:(!writer&&owner);
         });
         if(selected.length>=count){
           const sorted=selected.sort((x,y)=>Date.parse(y.created_at??'')-Date.parse(x.created_at??''));
           return {raw:{comments:sorted.slice(0,count)},cached:true,cacheTimeMs:fs.statSync(path.join(cacheDir,filename)).mtimeMs};
         }
       }catch{}
     }
   }
 }
 if(source){const saved=(opts.cacheSession||require('./cache-session').createCacheSession()).read(source),raw=saved.raw;if(apiError(raw))throw Error('缓存中的请求错误：'+apiError(raw));
 const parsed=rawArray(raw,kind);if(!parsed)throw Error('缓存不包含正确记录数组：'+source);
 return {raw,cached:true,file:source,responseHash:saved.hash,cacheTimeMs:saved.stamp};}
 if(opts.offline&&!recovered)return null;
 if(kind==='post-comments'){const base=require('./exchange-store').baseFor(dir);require('./post-reading-state').start(base,opts.postId);require('./post-reading-state').recover(base,opts.postId);}
 require('./cancellation').check();
 const def=ENDPOINTS[kind];const args=[...def.command,...(kind==='post-comments'?['--id',opts.postId]:['--uid',opts.uid]),'--count',String(count),'--page',String(page)];
 if(kind==='post-comments')args.push('--filter_by_author','0');
 if(maxId)args.push('--max_id',maxId);
 if(sinceId)args.push('--since_id',sinceId);
 args.push('--output','json');
 
 if(!recovered&&journal.unknown(dir,query)){
  let allowed=false;try{allowed=opts.autoGuard?.allowServiceRetry?.(query)===true;}catch{}
  if(!allowed)throw Object.assign(Error('上次在途请求结果未知，停止重复请求；数据和费用证据保留'),{code:opts.autoGuard?'AUTO_OUTCOME_UNKNOWN':'REQUEST_EVIDENCE_INVALID'});
 }
 const context={taskId:query.taskId,windowId:opts.subscriptionWindowId||''};
 const separatelyValidateWindow=context.windowId&&!opts.autoGuard?.job?.automaticRecovery?.kinds?.includes(kind);
 const verifyWindow=()=>{if(separatelyValidateWindow)require('./subscription-latest').validateWindow(dir,kind,query.uid,{...context,sinceId:query.sinceId,maxId:query.maxId});};
 if(!recovered){opts.creditMeter?.prepare(kind);verifyWindow();}
 const reservation=!recovered&&opts.autoGuard?.reserve(kind,count,sinceId,maxId,context),billingReservation=reservation&&/^[a-f0-9-]{36}$/.test(opts.autoGuard?.job?.id||'')?{id:reservation,roundId:opts.autoGuard.job.id}:undefined,attempt=recovered?.attempt||journal.begin(dir,query,billingReservation);
 let receipt=null,raw,output,captured=recovered?.attempt?.received||null,wireAttempt=false,responseReceived=false,responseSaved=!!captured,meterRecorded=false,settled=false,billingUnverified=false,returned=0;
 function persistCache(bytes){
  require('./response-cache').save(cache,bytes);
 }
 try{
  if(recovered){output=recovered.responseText;responseReceived=true;}
  else{verifyWindow();opts.autoGuard?.validateAutomaticWire?.(reservation,query,context);wireAttempt=true;output=runCli(args);responseReceived=true;captured=attempt?journal.receive(attempt,output,cache):journal.receiveStandalone(dir,query,output,cache);responseSaved=true;}
  try{raw=JSON.parse(output);}catch{throw Object.assign(Error('接口未返回有效 JSON，已保存原始响应，未推进读取位置'),{code:'REQUEST_EVIDENCE_INVALID'});}
  const message=apiError(raw);if(message)throw Object.assign(Error(message),executionFailed(raw)?{code:reservation||attempt?.billingReservation?'AUTO_RESPONSE_INVALID':'REQUEST_EVIDENCE_INVALID',billingUnknown:true}:{});
  const array=rawArray(raw,kind);if(!array)throw Object.assign(Error('未识别响应数组，原始响应保留，未推进读取位置'),{code:'REQUEST_EVIDENCE_INVALID'});
  returned=array.items.length;billingUnverified=unverifiedBilling(raw);
  if(!recovered){
   if(reservation){
    const settlement=opts.autoGuard.settle(reservation,{raw,file:path.relative(dir,captured.file),responseHash:captured.hash});
    billingUnverified||=settlement?.unverified===true;settled=true;
   }
   opts.creditMeter?.record(kind,raw,{billingUnverified});meterRecorded=true;
  }
  if(recovered)try{const settlement=journal.settleReceived(dir,attempt,raw);billingUnverified||=settlement?.unverified===true;if(billingUnverified)opts.creditMeter?.uncertain();}catch(error){error.billingUnknown=true;throw error;}
  const known=attempt?(opts.knownRecordIds||new Set((kind==='post-comments'?require('./local-database').localPostComments(opts,dir).rows.map(r=>r.recordId):[...require('./completeness').loadIndependentArchive(dir,kind,opts.uid).records.keys()]))):null;
  const rows=kind==='post-comments'?require('./post-comments').postPageRows(raw,opts.postId).rows:array.items.map(row=>{const r=require('./core').normalize(row,kind,opts.uid);return require('./record-body').completeBody(r,row)?r:null;}).filter(Boolean);
  if(attempt){attempt.firstSavedIds=rows.filter(r=>require('./record-body').completeBody(r)&&!known.has(r.recordId)).map(r=>r.recordId);receipt=journal.save(attempt,raw,cache);for(const id of attempt.firstSavedIds)opts.knownRecordIds?.add(id);}
  if(kind==='post-comments')require('./post-reading-state').recover(require('./exchange-store').baseFor(dir),opts.postId);
  const bytes=Buffer.from(output);persistCache(bytes);
  const saved=opts.cacheSession?.remember(cache,bytes,raw);
  return {raw,cached:!!recovered,file:cache,responseHash:saved?.hash||crypto.createHash('sha256').update(bytes).digest('hex'),cacheTimeMs:saved?.stamp||fs.statSync(cache).mtimeMs,...(recovered?{recoveredRequest:true}:{}),...(receipt?{receipt:{...receipt,file:path.relative(dir,receipt.file)}}:{})};
 }catch(error){
  if(wireAttempt&&error.serviceRejectionCapture){
   responseReceived=true;
   try{error.serviceRejection=journal.rejectService(dir,query,attempt,error.serviceRejectionCapture);responseSaved=true;error.code=error.serviceRejection.code;error.message=require('./service-rejection').message;}
   catch(saveError){error.code='REQUEST_EVIDENCE_INVALID';error.message='服务拒绝回执未能可靠保存，未继续请求；原任务和费用状态保留';error.serviceReceiptSaveCode=require('./diagnostic-codes').safe(saveError.code);}
   delete error.serviceRejectionCapture;
  }
  responseSaved||=!!attempt?.received;
  error.apiAttempt=wireAttempt;error.cached=!!recovered;error.responseReceived=responseReceived;error.responseSaved=responseSaved;error.returnedRecords=wireAttempt&&responseSaved?returned:0;error.billingUnknown=error.billingUnknown??(billingUnverified||wireAttempt&&(!meterRecorded||!!reservation&&!settled));
  let noWireProof=null,noWireSettled=false;
  if(!wireAttempt&&!recovered&&attempt)try{noWireProof=journal.markNotSent(dir,attempt,error.code);error.sdkNotInvoked=true;if(reservation){opts.autoGuard.notSent(reservation,noWireProof);noWireSettled=true;}error.billingUnknown=false;}catch(localError){error.notSentFailureCode=require('./diagnostic-codes').safe(localError.code);}
  // A secondary evidence/ledger failure cannot erase the original request facts.
  if(!noWireProof)try{journal.fail(attempt,error);}catch(journalError){error.journalFailureCode=require('./diagnostic-codes').safe(journalError.code);}
  if(wireAttempt&&!meterRecorded)try{opts.creditMeter?.fail();}catch(meterError){error.creditFailureCode=require('./diagnostic-codes').safe(meterError.code);}
  if(reservation&&!settled&&!noWireSettled)try{opts.autoGuard.fail(reservation,error);}catch(budgetError){error.billingFailureCode=require('./diagnostic-codes').safe(budgetError.code);}
  throw error;
 }

}

module.exports={validateLegacyControl,indexRead,mappedFolder,commitName,storagePaths,folderComponent,mergeStoredPath,postIdFromFolder,postSourceFromFolder,findPostFolder,commitPostFolder,prepareOutputLayout,legacy,cacheFile,getOne};
