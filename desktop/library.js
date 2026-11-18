'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {COMMANDS,MODES}=require('../lib/config');
const {sortRecords}=require('../lib/core');
const {loadIndependentArchive,exactId}=require('../lib/completeness');
const {render}=require('../lib/reader');
const {reportPayload,formalIds}=require('../lib/report-records');
const comments=new Set(['sent','received','both']);
function jsonFile(file,fallback){try{return require('../lib/file-view-cache').readJSON(file);}catch(error){if(error.code==='ENOENT')return fallback;throw Object.assign(Error('本地设置无法读取，原文件已保留：'+path.basename(file)),{code:error.code||'LOCAL_SETTINGS_INVALID'});}}
function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
function settingsPath(workspace){return path.join(require('../lib/data-layout').readerRoot(workspace),'preferences.json');}
function preferences(workspace){const p=jsonFile(settingsPath(workspace),{schema:1,favorites:[]});if(!p||p.schema!==1||!Array.isArray(p.favorites)||p.postFavorites!==undefined&&!Array.isArray(p.postFavorites))throw Error('特别关注设置格式无效，原文件已保留');return {...p,postFavorites:[...new Set((Array.isArray(p.postFavorites)?p.postFavorites:[]).filter(id=>/^\d{5,20}$/.test(id)))],reportKeep:1,favorites:[...new Set(p.favorites.filter(id=>/^\d{5,20}$/.test(id)))]};}
function reportRetention(workspace,keep){const p=preferences(workspace);p.reportKeep=1;atomic(settingsPath(workspace),p);return p;}
function cleanup(workspace,protect=[]){return cleanupOwnerReports(workspace,protect);}
function reportOwnerKey(report){
 const post=report.category==='post-comments',id=post?report.postId:report.uid;
 return typeof id==='string'&&/^\d{5,20}$/.test(id)?(post?'post:':'user:')+id:'';
}
function reportOwnerOf(file,catalog){
 const id=require('../lib/report-catalog').normalizeId(file),[category,folder]=id.split('/'),meta=require('../lib/report-catalog').entryOf(catalog,id);
 return reportOwnerKey({category,uid:meta?.uid,postId:category==='post-comments'?require('../lib/storage').postIdFromFolder(folder):''});
}
function reportOwners(workspace,files){
 const catalog=require('../lib/report-catalog').metadata(workspace).entries;
 return new Set(files.map(file=>reportOwnerOf(file,catalog)).filter(Boolean));
}
function cleanupOwnerReports(workspace,protect=[]){
 const owners=reportOwners(workspace,protect);
 return require('./report-retention').cleanupReports(workspace,{keep:1,perOwner:true,protect,listReports:base=>listReports(base,{includeDatabase:false,owners:owners.size?owners:null}),containedReport});
}
function favorite(workspace,uid,on){if(!/^\d{5,20}$/.test(uid))throw Error('特别关注需要有效用户 UID');const p=preferences(workspace);p.favorites=p.favorites.filter(id=>id!==uid);if(on)p.favorites.unshift(uid);atomic(settingsPath(workspace),p);return p;}
function listAccounts(workspace,{identityOnly=false}={}){
 const users=new Map();
 for(const category of ['user-comments','posts']){
  const file=path.join(require('../lib/storage').storagePaths(workspace).data||path.join(workspace,'output'),category,'.account_names.json');let index;try{index=jsonFile(file,{});}catch{continue;}
  for(const [uid,value]of Object.entries(index))if(/^\d{5,20}$/.test(uid)&&typeof value?.nickname==='string'&&!users.has(uid))users.set(uid,{uid,nickname:value.nickname,folder:value.folder});
 }
 try{const extra=require('../lib/file-view-cache').readJSON(require('./user-workspace').registry(workspace));for(const e of Object.values(extra.users||{}))if(/^\d{5,20}$/.test(e.uid)){
  const known=users.get(e.uid);
  if(!known)users.set(e.uid,e);
  else if(identityOnly)users.set(e.uid,{...e,...known});
 }}catch{}
 for(const uid of preferences(workspace).favorites)if(!users.has(uid))users.set(uid,{uid,nickname:'用户 '+uid});
 return [...users.values()].map(({uid,nickname,note,lastViewedAt})=>({
  uid,nickname:typeof nickname==='string'&&nickname?nickname:'用户 '+uid,
  ...(identityOnly&&typeof note==='string'?{note}:{}),
  ...(identityOnly&&typeof lastViewedAt==='string'?{lastViewedAt}:{})
 })).sort((a,b)=>a.nickname.localeCompare(b.nickname,'zh-CN'));
}
function describe(name,category,account,uid=''){
 const modern=require('../lib/report-name').parse(name),merged=name.endsWith('_互动总报告.html');let mode=modern?.mode||'',count=modern?.count??null,before='',from='',to='';
 for(const kind of ['both','sent','received','mentions-comments','mentions-posts']){const re=new RegExp('_'+MODES[kind]+'(?:_截至(\\d{8}))?(?:_本次取回_\\d{14})?(?:_未完成)?_(\\d+)条\\.html$'),m=name.match(re);if(m){mode=kind;before=m[1]||'';count=Number(m[2]);break;}}
 if(category==='post-comments'){mode='post-comments';if(!modern)count=Number(name.match(/_(\d+)条\.html$/)?.[1])||null;}
 if(category==='posts'){mode='user-posts';const m=name.match(/_微博_(\d{8})-(\d{8})(?:_未完成)?_(\d+)条\.html$/);if(m){[,from,to]=m;count=Number(m[3]);}}
 const batch=name.match(/_本地_更新(\d{17})(?:_未完成)?_(\d+)条\.html$/);if(batch){count=Number(batch[2]);mode=Object.keys(MODES).find(k=>name.includes('_'+MODES[k]+'_本地_'))||mode;}
 const local=name.match(/_本地_(\d{8})-(\d{8})_(\d+)条\.html$/),localAll=/_本地_全部日期_(\d+)条\.html$/.exec(name),database=!!local||!!localAll||!!batch;if(localAll){count=Number(localAll[1]);if(category==='user-comments')mode=Object.keys(MODES).find(k=>name.includes('_'+MODES[k]+'_本地_'))||mode;}if(local){[,from,to]=local;count=Number(local[3]);if(category==='user-comments')mode=Object.keys(MODES).find(k=>name.includes('_'+MODES[k]+'_本地_'))||mode;}
 if(merged)mode='both';const date=value=>value?value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6):'';
 const scope=modern?'本地生成 · '+modern.date:batch?'本次更新 · '+batch[1].slice(0,4)+'-'+batch[1].slice(4,6)+'-'+batch[1].slice(6,8):database?'本地生成 · '+(from?date(from)+' — '+date(to):'全部已保存日期'):merged?'本地合并总报告':name.includes('_本次取回_')?'单次已取回记录（本地重建）':before?'截至 '+date(before):from?date(from)+' — '+date(to):'最近已保存记录';
 return {uid,account,postId:category==='post-comments'?require('../lib/storage').postIdFromFolder(account):'',mode,modeLabel:merged?'互动总报告':MODES[mode]||'其他报告',count,before:date(before),from:date(from),to:date(to),partial:name.includes('_未完成'),merged,database,batch:!!batch,scope,collection:mode+'|'+before+'|'+from+'|'+to+(batch?'|batch':database?'|local':'')};
}
function listReports(workspace,{includeDatabase=true,database=includeDatabase?require('../lib/database-sync').statuses(workspace):[],owners=null}={}){
 const root=path.join(workspace,'output'),reports=[],catalog=require('../lib/report-catalog').metadata(workspace).entries;
 const catalogApi=require('../lib/report-catalog'),byOwner=new Map();for(const entry of database){const key=entry.category+'|'+(entry.uid||entry.target),previous=byOwner.get(key);if(!previous||String(previous.updatedAt)<String(entry.updatedAt))byOwner.set(key,entry);}
 // Build the folder lookup once, instead of searching the full catalog per folder.
 const catalogOwners=new Map();for(const [id,value]of Object.entries(catalog)){const parts=catalogApi.normalizeId(id).split('/');if(parts.length===3&&value.uid&&!catalogOwners.has(parts[0]+'/'+parts[1]))catalogOwners.set(parts[0]+'/'+parts[1],value.uid);}
 const fallback=new Map();
 for(const category of ['user-comments','post-comments','posts']){
  const base=path.join(root,category);if(!fs.existsSync(base))continue;let mapping={};try{mapping=jsonFile(path.join(require('../lib/storage').storagePaths(workspace).data||root,category,'.account_names.json'),{});}catch{}
  const byFolder=new Map(Object.entries(mapping).map(([uid,r])=>[r.folder,{uid,nickname:r.nickname}]));
  for(const folder of fs.readdirSync(base,{withFileTypes:true})){
   if(!folder.isDirectory()||folder.isSymbolicLink())continue;const dir=path.join(base,folder.name),user=byFolder.get(folder.name)||{};const ownerUid=user.uid||catalogOwners.get(category+'/'+folder.name)||'';if(owners&&!owners.has(category==='post-comments'?'post:'+require('../lib/storage').postIdFromFolder(folder.name):'user:'+ownerUid))continue;
   for(const name of fs.readdirSync(dir,{withFileTypes:true})){
    if(!name.isFile()||!name.name.endsWith('.html'))continue;const file=path.join(dir,name.name);let stat;try{stat=fs.statSync(file);}catch{continue;}
    const id=catalogApi.normalizeId(path.relative(root,file)),data={...describe(name.name,category,user.nickname||folder.name,user.uid||''),...(catalogApi.entryOf(catalog,id)||{})};
    if(data.merged){try{const meta=jsonFile(path.join(require('../lib/data-layout').readerRoot(workspace),'merges',data.uid+'.json'),null);if(meta){data.count=meta.count;data.partial=!!meta.missing?.length||!!meta.coverageIncomplete;data.sourceCount=meta.sourceCount;}}catch{}}
    let db=byOwner.get(category+'|'+(data.uid||data.postId||data.account));
    if(!db&&fallback.has(dir))db=fallback.get(dir);else if(includeDatabase&&!db){const runs=path.join(require('../lib/data-layout').dataForReport(workspace,dir),'cache/runs');try{const newest=fs.readdirSync(runs).filter(n=>n.endsWith('.json')).sort().at(-1),run=newest?jsonFile(path.join(runs,newest),null):null;if(run?.uid===data.uid)db={updatedAt:run.createdAt,incomplete:run.endpoints?.some(e=>e.result?.incomplete||e.coverageUnverified)};}catch{}fallback.set(dir,db);}
    reports.push({databaseUpdatedAt:db?.updatedAt||null,databaseIncomplete:!!db?.incomplete,id,name:name.name.replace(/\.html$/,''),category,size:stat.size,modified:stat.mtimeMs,...data,ownerKey:reportOwnerKey({...data,category,uid:data.uid||ownerUid})});
   }
  }
 }
 return reports.sort((a,b)=>b.modified-a.modified);
}
function containedReport(workspace,id){
 id=require('../lib/report-catalog').normalizeId(id);
 if(typeof id!=='string'||!id||path.isAbsolute(id)||id.includes('\0')||id.split('/').includes('..'))throw Error('报告路径无效');const output=path.resolve(workspace,'output'),file=path.resolve(output,id);
 if(!file.startsWith(output+path.sep)||!file.endsWith('.html')||!fs.existsSync(file))throw Error('报告不存在或不在当前资料目录内');
 const actual=fs.realpathSync(file),root=fs.realpathSync(output);if(!actual.startsWith(root+path.sep)||!fs.statSync(actual).isFile())throw Error('报告路径越界');return actual;
}
function readPayload(html,uid){const match=html.match(/<script type="application\/json" id="weibo-merged-records">([\s\S]*?)<\/script>/);if(!match)return [];
 try{const p=JSON.parse(match[1]);return p.uid===uid&&Array.isArray(p.rows)?p.rows.filter(r=>exactId(r.recordId)&&!r.isContext&&Number.isFinite(r.ms)&&typeof r.content==='string'):[];}catch{return [];}}
function latestCollectionCoverage(folder,uid){
 const dir=path.join(folder,'cache/runs');if(!fs.existsSync(dir))return null;
 const files=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort().reverse(),known=new Map();let createdAt='';
 for(const name of files){let run;try{run=jsonFile(path.join(dir,name),null);}catch{continue;}
  if(!run||run.uid!==uid||run.beforeMs!=null||run.limit!=null||!['sent','received','both','all'].includes(run.mode))continue;
  for(const e of run.endpoints||[])if(['sent','received'].includes(e.kind)&&!e.update&&!known.has(e.kind)){known.set(e.kind,e);if(!createdAt)createdAt=run.createdAt;}
  if(known.size===2)break;
 }
 if(!known.size)return null;const incomplete=e=>e.result?.incomplete||e.coverageUnverified||e.unknownTimeIds?.length||!e.ended||e.update&&!e.update.caughtUp;
 const endpoints=[...known.values()];return {incomplete:endpoints.some(incomplete),createdAt,endpoints:endpoints.map(e=>({kind:e.kind,incomplete:!!incomplete(e)})),reason:endpoints.filter(incomplete).map(e=>(e.kind==='received'?'收到':'发出')+'：'+e.reason).join('；')};
}
function recordObservations(folder,uid){
 const observations=new Map(),dir=path.join(folder,'cache/runs');if(!fs.existsSync(dir))return observations;
 for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort()){
  let run;try{run=jsonFile(path.join(dir,name),null);}catch{continue;}if(run?.uid!==uid)continue;
  for(const source of run.endpoints||[])if(['sent','received'].includes(source.kind))for(const record of source.records||[]){
   if(!exactId(record.id)||!record.isRecovered&&record.provenance?.type!=='api')continue;
   const stamp=Date.parse(run.createdAt),previous=observations.get(record.id);if(!Number.isFinite(stamp)||previous&&previous.stamp>stamp)continue;
   observations.set(record.id,{stamp,isRecovered:!!record.isRecovered,provenance:record.provenance});
  }
 }
 return observations;
}
function mergeReports(workspace,uid){
 if(!/^\d{5,20}$/.test(uid))throw Error('请选择有明确 UID 的用户');
 const reports=listReports(workspace).filter(r=>r.uid===uid&&r.category==='user-comments'&&comments.has(r.mode));if(!reports.length)throw Error('该用户没有可合并的评论报告');
 const previous=jsonFile(path.join(require('../lib/data-layout').readerRoot(workspace),'merges',uid+'.json'),{sources:{}}),wanted=new Map(),portable=new Map(),markers=new Map(),sources={};
 const reportFolder=path.dirname(containedReport(workspace,reports[0].id)),folder=require('../lib/data-layout').dataForReport(workspace,reportFolder);
 for(const report of reports){
  let ids,html='';const saved=previous.sources?.[report.id];
  if(saved&&saved.modified===report.modified&&saved.size===report.size&&!report.merged)ids=saved.ids;
  else{html=fs.readFileSync(containedReport(workspace,report.id),'utf8');if(!html.includes('data-target-uid="'+uid+'"'))continue;ids=formalIds(html,uid);}
  for(const id of ids||[])if(exactId(id)){if(!wanted.has(id))wanted.set(id,new Set());const kinds=report.mode==='both'?['sent','received']:[report.mode];for(const k of kinds)wanted.get(id).add(k);}
  if(!html)html=fs.readFileSync(containedReport(workspace,report.id),'utf8');
  const payload=reportPayload(html,uid),savedRows=require('../lib/report-catalog').privateRows(workspace,containedReport(workspace,report.id),uid)||payload?.rows||readPayload(html,uid);
  for(const row of savedRows){const old=portable.get(row.recordId);if(!old||!old.isRecovered&&row.isRecovered)portable.set(row.recordId,row);}
  // Legacy reports contain per-record badges but no normalized snapshot.
  // Preserve those observations instead of resetting every row to cache-visible.
  const recoveredIds=saved?.recoveredIds||[...html.matchAll(/<(?:article|tr)\b[^>]*\bdata-item\b[^>]*data-comment-id="(\d+)"[^>]*>([\s\S]*?)<\/(?:article|tr)>/g)].filter(m=>m[2].includes('class="archive-badge"')).map(m=>m[1]);
  for(const row of savedRows)if(row.isRecovered)recoveredIds.push(row.recordId);
  for(const id of recoveredIds)if(exactId(id)&&!markers.has(id))markers.set(id,{isRecovered:true});
  if(!report.merged)sources[report.id]={modified:report.modified,size:report.size,ids:ids||[],recoveredIds:[...new Set(recoveredIds)]};
 }
 const exported=path.join(folder,'cache/report-snapshots');if(fs.existsSync(exported))for(const name of fs.readdirSync(exported).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)))try{const bytes=fs.readFileSync(path.join(exported,name));if(crypto.createHash('sha256').update(bytes).digest('hex')!==name.slice(0,-5))continue;const saved=JSON.parse(bytes);if(saved?.schema!==1||saved.uid!==uid)continue;for(const row of saved.rows||[]){if(row.isContext||!exactId(row.recordId)||!Number.isFinite(row.ms)||!['sent','received','both'].includes(row.group))continue;if(!wanted.has(row.recordId))wanted.set(row.recordId,new Set());wanted.get(row.recordId).add(row.authorUid===uid?'sent':'received');if(!portable.has(row.recordId))portable.set(row.recordId,row);}}catch{}
 if(!wanted.size)throw Error('报告没有可识别的正式评论，无法安全合并');
 const archives={sent:loadIndependentArchive(folder,'sent',uid),received:loadIndependentArchive(folder,'received',uid)},recovered=new Set();
 for(const kind of ['sent','received'])try{for(const id of jsonFile(path.join(folder,'cache/updates',kind+'.json'),{}).recoveredIds||[])recovered.add(id);}catch{}
 const observations=recordObservations(folder,uid);
 const rows=[],missing=[];
 for(const [id,kinds]of wanted){let selected=null;for(const kind of kinds){const entry=archives[kind].records.get(id);if(entry&&(!selected||entry.stamp>selected.stamp))selected={...entry,kind};}
  const fallback=portable.get(id);if(!selected&&!fallback){missing.push(id);continue;}
  const observation=observations.get(id),prior=fallback||markers.get(id);
  const restored=observation?observation.isRecovered:!!(prior?.isRecovered||recovered.has(id));
  const provenance=observation?.provenance||prior?.provenance||selected?.provenance||{};
  const row={...(selected?.row||fallback),isRecovered:restored,provenance:{...provenance,type:restored?'archive':observation?.provenance?.type||'cache'}};
  row.group='both';row.type=row.authorUid===uid?'发出':'收到';rows.push(row);
 }
 if(!rows.length)throw Error('缺少可恢复的原始记录，原报告已保留');
 const label=reports[0].account,file=path.join(reportFolder,require('../lib/report-name').fileName(label,{mode:'both'},rows.length));
 const coverage=latestCollectionCoverage(folder,uid),coverageIncomplete=!!coverage?.incomplete;
 const meta={coverageUnverified:coverageIncomplete,kind:'both',budget:rows.length,fetched:rows.length,rows,requests:0,cachedCalls:0,ended:true,failed:missing.length>0,reason:coverageIncomplete?'最近一次不限量采集尚未核实完整；'+coverage.reason:missing.length?'部分正式记录缺少可恢复的本地原文':'已合并本地保存记录；不代表全部历史完整'};
 const info={schema:1,uid,coverageIncomplete,coverage,count:rows.length,sourceCount:Object.keys(sources).length,missing,mergedAt:new Date().toISOString(),sources};
 const options={uid,shareReport:true,mode:'both',offline:true,workspace,merged:true,reportPartial:coverageIncomplete||missing.length>0,mergeInfo:{sourceCount:info.sourceCount}},sorted=sortRecords(rows),catalog=require('../lib/report-catalog');
 const saved=catalog.write(file,options,sorted,label,()=>render(options,sorted,[meta],label),catalog.contentKey(options,sorted,[meta],label)),id=catalog.idOf(workspace,saved.file);
 atomic(path.join(require('../lib/data-layout').readerRoot(workspace),'merges',uid+'.json'),info);
 return {id,count:rows.length,sourceCount:info.sourceCount,missing:missing.length,incomplete:coverageIncomplete||missing.length>0,coverageIncomplete};
}
module.exports={reportOwnerOf,cleanup,cleanupOwnerReports,reportRetention,latestCollectionCoverage,preferences,favorite,listAccounts,listReports,containedReport,mergeReports,describe};
