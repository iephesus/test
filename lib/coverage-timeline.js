'use strict';
// Read-only interpretation: distribution is never evidence of continuous coverage.
const path=require('node:path'),C=require('./local-corpus'),V=require('./file-view-cache'),regular=require('./regular-file');
const PROOF_LIMIT=16*1024*1024;
const PROJECTION_VERSION=3;
function evidenceSnapshot(base,o){
 const r=require('./data-layout').readerRoot(base),cacheDir=path.resolve(o.dir,'cache'),a=V.manifest(cacheDir,{children:['data-updates','updates','update-connections','history-boundaries','request-journal','runs'],filter:/\.json$/}),b=V.manifest(path.join(r,'manual-tasks'),{filter:/^[a-f0-9-]{36}\.json$/});
 // Derived statistics and personal state must never invalidate their own build.
 const files=a.files.filter(e=>path.relative(cacheDir,e.file).includes(path.sep)||!/^(?:local-inventory|follow-inbox|cost-history)(?:[-.]|$)/.test(path.basename(e.file)));
 return {token:C.hash([files.map(e=>[e.file,e.signature]),b.signature]),runs:files.filter(e=>path.dirname(e.file)===path.join(cacheDir,'runs'))};
}
const evidenceManifest=(base,o)=>evidenceSnapshot(base,o).token;
function initialWindow(dir,kind,uid,proof,target,upper){
 const packets=new Map(),refs=[];
 for(const ref of proof){const saved=require('./incremental').restorePacket(ref,dir);if(saved.query?.uid!==uid||saved.query.kind!==kind)throw Error('首次边界请求身份不匹配');const name=ref.hash;refs.push(name);packets.set(name,{role:'packet',owner:{kind:'user',id:uid},channel:kind,query:require('./exchange-schema').query(saved.query,{kind:'user',id:uid},kind),response:require('./exchange-schema').response(saved.raw,kind),savedAt:saved.savedAt||new Date(0).toISOString(),trusted:true});}
 const verified=require('./exchange-progress').verifyChain(refs,packets,{initial:true,target});if(verified.head!==upper)throw Error('首次边界不匹配');return {type:'connected',label:'首次有限记录窗口已验证',lower:'',upper:verified.head,cursor:verified.cursor,count:verified.covered,detail:'只验证该记录窗口，不代表更早历史或整天完整。'};
}

async function build(base,input,opts={}){
 const uid=require('../desktop/ui/form-utils').uid(input.uid);if(!uid||uid!==input.uid)throw Error('时间轴需要精确用户 UID');
 require('./local-search').conditions({text:'timeline',from:input.from,to:input.to});
 const p=require('./storage'),root=p.storagePaths(base).users,o=C.objects(base).objects.find(o=>o.category==='user-comments'&&o.id===uid)||{id:uid,category:'user-comments',key:'user-comments:'+uid,dir:p.mappedFolder(root,uid,p.indexRead(root)),label:uid};
 const m=C.manifest(o),evidence=evidenceSnapshot(base,o),sig=C.hash([PROJECTION_VERSION,m.token,m.inventoryToken,evidence.token]),cache=path.join(require('./data-layout').readerRoot(base),'indexes','coverage-v1',C.hash(o.key)+'.json');let data;
 try{const box=JSON.parse(regular.read(cache,{maxBytes:PROOF_LIMIT}));if(box.schema===1&&box.token===sig&&box.hash===C.hash(box.data)&&box.data?.uid===uid&&!box.data.hasRunningTasks&&box.data.missingBodies&&Array.isArray(box.data.directions)&&box.data.directions.length===2&&box.data.directions.every(d=>d&&d.days&&Array.isArray(d.events)&&Array.isArray(d.pending)))data=box.data;}catch{}
 if(!data){
  const shard=await require('./local-search').ensure(base,o,{...opts,distribution:true}),tick=require('./local-work').checkpoint(opts.signal,6),directions=[];
  const inventory=require('./inventory-index'),candidates=await inventory.timelineMissingCandidates(o.dir,o,opts),missing=await require('./coverage-missing-directions').classify(o,candidates,evidence.runs,opts);
  const bodyIdsByKind={sent:new Set(),received:new Set()};for(const file of Object.values(shard.files))for(const row of file.rows)if(row.formal&&row.usable&&row.recordId)bodyIdsByKind[row.channel]?.add(row.recordId);
  const taskIndex=await require('./coverage-task-index').tasks(base,opts),jobs=[];
  const tasks=require('../desktop/task-status');let progress;
  try{progress=tasks.journalSnapshot(o.dir,uid);}catch(error){progress={values:[],warnings:[{message:error.message}]};}
  for(const task of taskIndex.tasks){if(task.uid!==uid||require('../desktop/ui/form-utils').uid(task.query?.target)!==uid||['post-comments','user-posts'].includes(task.query?.mode))continue;try{const o=require('./options').options([uid,task.query.mode,'--dry-run']);jobs.push({...task,_directions:require('./core').plan(o).map(p=>p.kind)});}catch{taskIndex.warnings.push('原任务 '+task.id+' 的旧内容方向无法解释');}}
  for(const kind of ['sent','received']){
   const rows=new Map();let unknownTime=0,unidentified=0;for(const s of Object.values(shard.files))for(const r of s.rows){if(r.channel!==kind||!r.formal)continue;if(!r.recordId){unidentified++;continue;}const old=rows.get(r.recordId);if(!old||!old.usable&&r.usable)rows.set(r.recordId,r);}const days={};
   for(const r of rows.values()){await tick();if(r.ms==null){unknownTime++;continue;}if(!r.usable)continue;const day=require('./date-range').dayOf(r.ms);days[day]=(days[day]||0)+1;}
   const events=[],warnings=[...new Set([...shard.warnings,...missing.warnings,...taskIndex.warnings])];let state=null;try{state=require('./incremental').readState(o.dir,kind,uid);}catch(e){warnings.push(e.message);}
   const journals=progress.values.filter(j=>j.kind===kind);
   for(const issue of progress.warnings)if(!issue.kind||issue.kind===kind)warnings.push(issue.message);
   if(state?.userSelectedHead)events.push({type:'user-skipped',label:'已主动忽略中间未读取区间',lower:state.userSelectedHead.previousAnchor,upper:state.userSelectedHead.head,detail:'后续检查使用当时已核实的最新保存记录；此处没有区间连接证明，旧正文与缺失证据保留。'});
   const seen=new Set();
   for(const j of journals){await tick();try{const proof=require('./regular-progress').connection(o.dir,kind,uid,j,undefined,{knownBodyIds:bodyIdsByKind[kind]});if(proof){const k=proof.lower+':'+proof.upper;if(!seen.has(k)){seen.add(k);events.push({type:'connected',label:'新增记录区间已验证连接',lower:proof.lower,upper:proof.upper,missing:proof.missingIds.length,from:rows.get(proof.lower)?.ms??null,to:rows.get(proof.upper)?.ms??null,detail:'连接依据为保存的请求／响应链；不代表跨越日期内全部互动。'});}}}catch(e){warnings.push('连接证据未核实：'+e.message);}}
   // Walk immutable connection proofs, validating response identities and cursors
   // with the same validators used by acquisition. Never promote an index to proof.
   let ref=state?.connection;const visited=new Set();
   while(ref){await tick();try{
    if(!/^update-connections\/[a-f0-9-]+\.json$/.test(ref.file||'')||visited.has(ref.hash))throw Error('连接链路径或循环无效');visited.add(ref.hash);
    const file=path.join(o.dir,'cache',ref.file),bytes=regular.read(file,{maxBytes:PROOF_LIMIT});if(C.hash(bytes)!==ref.hash)throw Error('连接证据缺失或哈希改变');const c=JSON.parse(bytes);if(c.schema!==1||c.uid!==uid||c.kind!==kind)throw Error('连接证据身份不匹配');
    if(c.initial)events.push(initialWindow(o.dir,kind,uid,c.packets,state.scope?.recentLimit??null,c.upper));
    else {const proof=require('./regular-progress').connection(o.dir,kind,uid,{...c,anchor:c.lower,head:c.upper,deltaComplete:true,phase:'body',since:!!c.packets?.[0]?.sinceId,deltaPackets:c.packets},undefined,{knownBodyIds:bodyIdsByKind[kind]});if(!proof)throw Error('请求边界未能验证连接');const k=proof.lower+':'+proof.upper;if(!seen.has(k)){seen.add(k);events.push({type:'connected',label:'新增记录区间已验证连接',lower:proof.lower,upper:proof.upper,missing:proof.missingIds.length,detail:'仅证明响应链的记录区间已连接；已知缺正文另外保留，不代表整天完整。'});}}
    ref=c.previous;
   }catch(e){warnings.push('连接证据未核实：'+e.message);break;}}
   if(!state?.connection&&state?.proof?.length)try{events.push(initialWindow(o.dir,kind,uid,state.proof,state.scope?.recentLimit??null,state.anchor));}catch(e){warnings.push('首次窗口未核实：'+e.message);}
   const scopedJobs=jobs.filter(t=>t._directions.includes(kind)),statuses=tasks.taskStatus(o.dir,uid,scopedJobs,state?[state]:[],{bodyIdsByKind,progress:progress.values});
   for(const task of scopedJobs){const sources=(task.summary?.sources||[]).filter(s=>s.kind===kind&&s.budget!==0);for(const source of sources){const status=require('./collection-result').collectionResult(source),covered=source.readProgress?.covered??source.fetched??0,quota=Number.isFinite(source.budget)&&covered>=source.budget;events.push({type:quota?'target':status.targetCovered?'window-end':'attempt',label:quota?'本次指定条数已满足':status.targetCovered?'本次可见读取范围已结束（不代表全部历史）':'获取范围尚未核实',taskId:task.id,count:covered,budget:source.budget??null,from:task.query.from||'',to:task.query.to||task.query.before||'',detail:'任务结果说明条数目标；不作为日期完整或区间连接证明。'});}}
   const pending=statuses.pendingTasks.filter(t=>(t.progressStatus?.directions||[]).some(d=>d.kind===kind)||!t.summary?.sources?.length).filter(t=>/^[a-f0-9-]{36}$/.test(t.id)).map(t=>{
    const owned=journals.filter(j=>j.ownerScopes?.includes(t.query?._scopeId)),refs=owned.flatMap(j=>j.packets||[]);let resumable=t.status!=='running'&&refs.length>0,reason=t.status==='running'?'原任务正在运行':'';
    try{if(!refs.length)throw Error('原任务没有可核实的响应续读证据');const actual=require('../desktop/user-workspace').resume(base,t.id,{inspect:'query'}),fields=['target','mode','from','to','before','limit','unlimited','_scopeId'];if(C.hash(fields.map(k=>actual[k]))!==C.hash(fields.map(k=>t.query[k])))throw Error('原任务范围已变化，请刷新');for(const p of refs){const {query}=require('./incremental').restorePacket(p,o.dir);if(query&&(query.uid!==uid||query.kind!==kind))throw Error('续读响应属于其他对象或方向');if(!query&&!(p.uid===uid&&p.kind===kind))throw Error('旧响应缺少可核实请求身份');}}catch(e){resumable=false;reason=e.message;}
    const interrupted=require('../desktop/ui/acquisition-feedback').interruptedTask(t);
    return {id:t.id,label:interrupted?'原任务意外中断':'待补区间',interrupted,resumable,reason,directions:t.progressStatus?.directions||[],scope:{mode:t.query.mode,from:t.query.from||'',to:t.query.to||t.query.before||'',limit:t.query.limit??null},startedAt:t.startedAt};
   });
   // Retain global pending facts even when there is no safe manual resume action.
   if(state?.pending)events.push({type:'pending',label:'新旧记录之间仍有待接通区间',lower:state.anchor,upper:state.pending.head,detail:pending.length?'可查看对应原任务；续读沿用其固定边界。':'没有可验证的手动续读入口，请在获取数据中检查原进度。'});
   directions.push({kind,days,records:[...rows.values()].filter(r=>r.usable).length,unknownTime,unidentified,missingBodyCount:missing.counts[kind],events,pending,warnings,unknown:!events.some(e=>e.type==='connected'),checkedAt:state?.checkedAt||null});
  }
  const after=C.manifest(o);if(after.token!==m.token||after.inventoryToken!==m.inventoryToken||after.inventoryToken!==candidates.token||evidenceManifest(base,o)!==evidence.token)throw Error('构建时间轴时本地证据发生变化，请刷新');
  data={uid,directions,missingBodies:missing.counts,hasRunningTasks:jobs.some(t=>t.status==='running'),note:'记录分布不代表当天已全部获取；无记录日期的覆盖情况未知。',credits:0};opts.signal?.throwIfAborted();try{require('./update-progress').atomic(cache,{schema:1,token:sig,data,hash:C.hash(data)});}catch(e){data.warnings=['时间轴摘要未保存：'+e.message];}
 }
 const start=input.from||'0000',end=input.to||'9999';return {...data,range:{from:input.from||'',to:input.to||''},snapshot:sig,directions:data.directions.map(d=>({...d,days:Object.fromEntries(Object.entries(d.days).filter(([day])=>day>=start&&day<=end))}))};
}
module.exports={build,evidenceManifest};
