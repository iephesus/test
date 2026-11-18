'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const X=require('../lib/data-exchange'),S=require('../lib/exchange-schema'),E=require('../lib/exchange-records'),I=require('../lib/incremental');
const uid='1000000101',peer='1234567890',post='90071992547409940';
const save=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v));};
function workspace(){const b=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-data-exchange-test-'));save(path.join(b,'data/.layout-v2'),2);return b;}
const dir=(b,id=uid)=>path.join(b,'data/user-comments',id);
function row(id,text='正文 '+id,author=uid){return {idstr:String(id),text,created_at:'2026-10-29T12:00:00+08:00',user:{idstr:author,screen_name:author===uid?'目标':'对方'},status:{idstr:post,text:'原微博',user:{idstr:peer,screen_name:'原作者'}}};}
function seed(b,ids=[103,102,101],kind='sent'){save(path.join(b,'data/user-comments/.account_names.json'),{[uid]:{folder:uid,nickname:'目标'}});save(path.join(dir(b),'cache',kind+'_c200_m0.json'),{comments:ids.map(n=>row(n,'正文 '+n,kind==='sent'?uid:peer)),next_cursor:'0'});return dir(b);}
async function pack(a,at){return (await X.exportPackage(a,'all',path.join(at,'sample.wrdpack'))).file;}
async function merge(b,p,opts){const check=await X.inspect(b,p);return {...await X.commit(b,check.id,opts),inspection:check};}
function loaded(b,k='sent'){return require('../lib/completeness').loadIndependentArchive(dir(b),k,uid).records;}
async function fixture(fn){const a=workspace(),b=workspace(),outside=workspace();const network=global.fetch;global.fetch=()=>{throw Error('NO_NETWORK_ALLOWED');};try{await fn({a,b,outside});}finally{global.fetch=network;for(const p of [a,b,outside])fs.rmSync(p,{recursive:true,force:true});}}
function parsePack(file){const original=fs.readFileSync(file),bytes=original[0]===31?require('zlib').gunzipSync(original):original,offset=X.MAGIC.length,n=bytes.readUInt32BE(offset);return {manifest:JSON.parse(bytes.subarray(offset+4,offset+4+n)),data:bytes.subarray(offset+4+n)};}
function malicious(file,manifest,data){const h=Buffer.from(JSON.stringify(manifest)),n=Buffer.alloc(4);n.writeUInt32BE(h.length);fs.writeFileSync(file,Buffer.concat([X.MAGIC,n,h,data]));}
test('exchange: empty import preserves exact records and quote context through existing offline HTML workflow',()=>fixture(async({a,b,outside})=>{
 seed(a);const f=path.join(dir(a),'cache/sent_c200_m0.json'),v=JSON.parse(fs.readFileSync(f));v.comments[0].reply_comment=row(90,'引用前文',peer);v.comments[0].reply_id='90';save(f,v);
 const p=await pack(a,outside),inspection=await X.inspect(b,p);assert.equal(inspection.summary.added,3);assert.equal(loaded(b).size,0,'inspection cannot write formal data');const result=await X.commit(b,inspection.id);assert.equal(result.added,3);assert.deepEqual([...loaded(b).keys()].sort(),['101','102','103']);
 const view=require('../desktop/local-view').createLocalView(b),query={target:uid,mode:'comments-sent',limit:'all',unlimited:true,markUnread:true},prepared=view.prepare(query);assert.equal(prepared.summary.selected,3);const exported=view.exportCurrent(query,prepared.token),html=fs.readFileSync(path.join(b,'output',exported.files[0]),'utf8');assert.match(html,/引用前文/);assert.match(html,/正文 103/);assert.equal(prepared.summary.credits,0);assert.deepEqual([...require('../lib/follow-inbox').unreadIds(require('../lib/follow-inbox').peek(b,uid))].sort(),['101','102','103']);
}));
test('exchange: post metadata skips desktop task projection and retains typed ownership after import',()=>fixture(async({a,b,outside})=>{
 seed(a,[103]);
 const postId=uid,postRow='9007199254740993',cache=path.join(a,'data/post-comments',postId,'cache/post-comments_c200_m0.json');
 save(cache,{status:{idstr:postId,text:'独立博文',user:{idstr:peer,screen_name:'博文作者'}},comments:[{...row(postRow,'独立博文的评论',peer),status:{idstr:postId}}],next_cursor:'0'});
 const savedAt=new Date('2026-10-30T00:00:00Z');
 for(const file of [cache,path.join(dir(a),'cache/sent_c200_m0.json')])fs.utimesSync(file,savedAt,savedAt);
 const tasks=path.join(a,'data/.reader/manual-tasks'),status=path.join(a,'data/.reader/database-status.json');
 for(let index=0;index<200;index++){
  const id='10000000-1000-4000-8000-'+String(index).padStart(12,'0');
  save(path.join(tasks,id+'.json'),{schema:1,id,startedAt:'2026-10-29T12:00:00Z',status:'complete',query:{mode:'post-comments',target:postId}});
 }
 save(status,{schema:1,entries:[{category:'post-comments',target:postId,updatedAt:'2029-01-01T00:00:00.000Z'}]});
 const readdir=fs.readdirSync,read=fs.readFileSync,scans={tasks:0,status:0};
 fs.readdirSync=function(file,...args){if(file===tasks)scans.tasks++;return readdir.call(this,file,...args);};
 fs.readFileSync=function(file,...args){if(file===status)scans.status++;return read.call(this,file,...args);};
 let file,duringEnumeration,duringExport;
 try{
  const before=performance.now(),listed=X.objects(a);
  duringEnumeration={...scans,ms:performance.now()-before};
  assert.deepEqual(listed.map(S.key),['post:'+postId,'user:'+uid]);
  scans.tasks=0;scans.status=0;
  const start=performance.now();file=await pack(a,outside);
  duringExport={...scans,ms:performance.now()-start};
 }finally{fs.readdirSync=readdir;fs.readFileSync=read;}
 const {manifest,data}=parsePack(file);
 assert.deepEqual(manifest.objects.find(o=>o.kind==='post'),{kind:'post',id:postId,title:'独立博文',author:'博文作者',authorUid:peer});
 assert.deepEqual(manifest.objects.map(S.key),['post:'+postId,'user:'+uid]);
 assert.equal(manifest.files.reduce((n,e)=>n+e.bytes,0),data.length);
 if(process.env.WEIBO_ARCH_MEASURE)console.log(JSON.stringify({duringEnumeration,duringExport,files:manifest.files.map(f=>f.sha256)}));
 assert.equal((await merge(b,file)).added,2);
 assert.equal(loaded(b).get('103').row.content,'正文 103');
 const records=require('../lib/local-database').localPostComments({postId},path.join(b,'data/post-comments',postId)).rows;
 assert.deepEqual(records.map(r=>[r.recordId,r.content]),[[postRow,'独立博文的评论']]);
 assert.equal(require('../desktop/post-workspace').list(a)[0].updatedAt,'2029-01-01T00:00:00.000Z');
 assert.deepEqual([duringEnumeration.tasks,duringEnumeration.status,duringExport.tasks,duringExport.status],[0,0,1,0],'only the export safety check scans manual tasks');
}));
test('exchange: duplicate and crossed reimports remain idempotent and never unread already-read records',()=>fixture(async({a,b,outside})=>{
 seed(a);const p=await pack(a,outside);await merge(b,p);const inbox=require('../lib/follow-inbox'),file=inbox.file(b,uid),box=JSON.parse(fs.readFileSync(file));box.items['103'].readAt='2026-10-30T00:00:00Z';save(file,box);const before=fs.readFileSync(file);
 const duplicate=await merge(b,p);assert.equal(duplicate.added,0);assert.equal(duplicate.duplicate,3);assert.deepEqual(fs.readFileSync(file),before);
 const back=await pack(b,outside);await merge(a,back);await merge(b,await pack(a,outside));assert.equal(loaded(a).size,3);assert.equal(loaded(b).size,3);assert.deepEqual(fs.readFileSync(file),before);
}));
test('exchange: complete local versions win conflicts, all versions retained, placeholders never replace bodies',()=>fixture(async({a,b,outside})=>{
 seed(a,[103,102]);seed(b,[103]);const f=path.join(dir(b),'cache/sent_c200_m0.json'),v=JSON.parse(fs.readFileSync(f));v.comments[0].text='本机首选版本';save(f,v);const p=await pack(a,outside),r=await merge(b,p);assert.equal(r.added,1);assert.equal(r.conflicts,1);assert.equal(loaded(b).get('103').row.content,'本机首选版本');assert.equal(E.versions(dir(b),'sent',uid).get('103').size,1);
 const changed=JSON.parse(fs.readFileSync(path.join(dir(a),'cache/sent_c200_m0.json')));changed.comments[0].text='另一个版本';changed.comments[1].deleted=true;changed.comments[1].text='';save(path.join(dir(a),'cache/sent_c200_m0.json'),changed);await merge(b,await pack(a,outside));assert.equal(loaded(b).get('102').row.content,'正文 102');assert.equal(E.versions(dir(b),'sent',uid).get('103').size,2);
}));
test('exchange: credentials, notes, read flags, budget and HTML are absent from whitelist package',()=>fixture(async({a,b,outside})=>{
 seed(a,[103]);const f=path.join(dir(a),'cache/sent_c200_m0.json'),v=JSON.parse(fs.readFileSync(f));v.token='SECRET_TOKEN';v.balance=123456;v.user={idstr:uid,screen_name:'SERVICE_ACCOUNT'};v.comments[0].authorization='SECRET_HEADER';v.comments[0].user.note='PRIVATE_PROFILE';save(f,v);
 save(path.join(a,'data/.reader/users.json'),{schema:1,users:{[uid]:{uid,nickname:'目标',note:'PRIVATE_NOTE'}}});save(path.join(a,'data/.reader/preferences.json'),{schema:1,favorites:[uid],token:'PRIVATE_CONFIG'});save(path.join(dir(a),'cache/follow-inbox.json'),{schema:1,uid,items:{103:{id:'103',readAt:'PRIVATE_READ'}}});save(path.join(a,'output/private.html'),{text:'PRIVATE_HTML'});
 const p=await pack(a,outside),bytes=fs.readFileSync(p).toString();for(const secret of ['SECRET_TOKEN','SECRET_HEADER','SERVICE_ACCOUNT','PRIVATE_NOTE','PRIVATE_CONFIG','PRIVATE_READ','PRIVATE_HTML','PRIVATE_PROFILE'])assert.ok(!bytes.includes(secret),secret);await merge(b,p);assert.equal(require('../desktop/library').preferences(b).favorites.length,0);
}));
test('exchange: importing leaves local notes, favorites, subscriptions, budget and read state unchanged',()=>fixture(async({a,b,outside})=>{
 seed(a,[103,102]);seed(b,[103]);const privateFiles=[['data/.reader/users.json',{schema:1,users:{[uid]:{uid,nickname:'本机名称',note:'仅本机'}}}],['data/.reader/preferences.json',{schema:1,favorites:[uid]}],['data/.reader/auto-follow/config.json',{enabled:true,budget:100}],['data/.reader/auto-follow/rounds/private.json',{fee:30}]];for(const [f,v]of privateFiles)save(path.join(b,f),v);const originals=privateFiles.map(([f])=>[f,fs.readFileSync(path.join(b,f))]);await merge(b,await pack(a,outside));for(const [f,bytes]of originals)assert.deepEqual(fs.readFileSync(path.join(b,f)),bytes,f);
}));
test('exchange: sent/received, post/user-posts and quotes retain separate typed ownership',()=>fixture(async({a,b,outside})=>{
 seed(a,[103]);seed(a,[104],'received');const pd=path.join(a,'data/post-comments',post);save(path.join(pd,'cache/post-comments_c200_m0.json'),{status:{idstr:post,text:'原微博',user:{idstr:uid,screen_name:'目标'}},comments:[row(105,'博文评论',peer)],next_cursor:'0'});
 const ud=path.join(a,'data/posts',uid);save(path.join(a,'data/posts/.account_names.json'),{[uid]:{folder:uid,nickname:'目标'}});save(path.join(ud,'cache/user-posts_c100_m0.json'),{schema:1,endpoint:'statuses user_timeline/other',query:{uid,count:100,max_id:'',since_id:'',page:1,from:'2026-10-29',to:'2026-10-29',start_time:1793203199,end_time:1793289600},savedAt:'2026-10-30T00:00:00Z',response:{statuses:[row(106,'用户微博')],next_cursor:'0'}});
 await merge(b,await pack(a,outside));assert.equal(loaded(b).size,1);assert.equal(loaded(b,'received').size,1);assert.equal(require('../lib/local-database').localPostComments({postId:post},path.join(b,'data/post-comments',post)).rows.length,1);assert.equal(require('../lib/local-database').localPosts({uid},path.join(b,'data/posts',uid)).rows.length,1);
}));
test('exchange: disk failure after body save resumes journal without duplicate data or billing',()=>fixture(async({a,b,outside})=>{
 seed(a);const p=await pack(a,outside),check=await X.inspect(b,p);let fault=true;await assert.rejects(X.commit(b,check.id,{inject:(phase,i)=>{if(fault&&phase==='after-write'&&i===0){fault=false;throw Object.assign(Error('disk full'),{code:'ENOSPC'});}}}),/disk full/);assert.equal(X.pending(b),true);assert.ok(fs.existsSync(require('../lib/exchange-store').database(b)),'shared immutable body commits before the per-owner reference');const recovered=await X.recover(b);assert.equal(recovered.length,1);assert.equal(X.pending(b),false);assert.equal(loaded(b).size,3);assert.equal((await X.commit(b,check.id)).reused,true);
}));
test('exchange: ordinary interruption preserves pending transaction; next process can roll forward safely',()=>fixture(async({a,b,outside})=>{
 seed(a);const p=await pack(a,outside),check=await X.inspect(b,p),controller=new AbortController();await assert.rejects(X.commit(b,check.id,{signal:controller.signal,inject:phase=>{if(phase==='after-write')controller.abort();}}),/中断/);assert.equal(X.pending(b),true);await X.recover(b);assert.equal(loaded(b).size,3);
}));
test('exchange: startup finds the pointer when publishing the applying plan is interrupted',()=>fixture(async({a,b,outside})=>{
 seed(a);const check=await X.inspect(b,await pack(a,outside));
 const root=path.join(b,'data/.reader/exchange'),job=path.join(root,'transactions',check.id,'job.json'),pointer=path.join(root,'pending.json'),rename=fs.renameSync;
 fs.renameSync=function(source,target){
  if(target===job){assert.equal(JSON.parse(fs.readFileSync(pointer)).id,check.id);throw Error('interrupted before publishing applying plan');}
  return rename.call(this,source,target);
 };
 try{await assert.rejects(X.commit(b,check.id),/publishing applying plan/);}finally{fs.renameSync=rename;}
 assert.equal(X.pending(b),true);assert.equal(JSON.parse(fs.readFileSync(job)).status,'inspected');assert.equal(loaded(b).size,0);
 assert.deepEqual(await X.recover(b),[]);assert.equal(X.pending(b),false);assert.equal(loaded(b).size,0);
 assert.equal((await X.commit(b,check.id)).added,3);
 const readdir=fs.readdirSync;
 fs.readdirSync=function(folder,...args){if(folder===path.join(root,'transactions'))assert.fail('normal indexed recovery scanned old transactions');return readdir.call(this,folder,...args);};
 try{assert.equal(X.pending(b),false);assert.deepEqual(await X.recover(b),[]);}finally{fs.readdirSync=readdir;}
}));
test('exchange: another process cannot clear the recovery pointer while the applying plan is being published',()=>fixture(async({a,b,outside})=>{
 seed(a);const checked=await X.inspect(b,await pack(a,outside));
 const root=path.join(b,'data/.reader/exchange'),job=path.join(root,'transactions',checked.id,'job.json'),pointer=path.join(root,'pending.json'),rename=fs.renameSync;
 let attempted=false;
 fs.renameSync=function(source,target){
  if(target===job&&!attempted){
   attempted=true;assert.equal(JSON.parse(fs.readFileSync(pointer)).id,checked.id);
   const code=`const assert=require('node:assert/strict'),X=require(${JSON.stringify(require.resolve('../lib/data-exchange'))});
   assert.throws(()=>X.discard(process.argv[1],process.argv[2]),{code:'DATA_LOCK_BUSY'});
   assert.rejects(X.recover(process.argv[1]),{code:'DATA_LOCK_BUSY'}).catch(error=>{console.error(error);process.exitCode=1;});`;
   const child=require('node:child_process').spawnSync(process.execPath,['-e',code,b,checked.id],{encoding:'utf8',timeout:5000});
   assert.equal(child.status,0,child.stdout+child.stderr);assert.equal(JSON.parse(fs.readFileSync(pointer)).id,checked.id);
  }
  return rename.call(this,source,target);
 };
 try{await assert.rejects(X.commit(b,checked.id,{inject(phase){if(phase==='before-write')throw Error('stop after plan publication');}}),/after plan publication/);}finally{fs.renameSync=rename;}
 assert(attempted);assert.equal(X.pending(b),true);assert.equal(JSON.parse(fs.readFileSync(job)).status,'applying');assert.equal(loaded(b).size,0);
 assert.equal((await X.recover(b))[0].added,3);assert.equal(X.pending(b),false);
}));
test('exchange: CLI checks for a new pending merge again after entering the writer barrier',()=>fixture(async({b})=>{
 const code=`const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),base=process.env.WEIBO_DESKTOP_PROJECT;
 const root=process.argv[1],X=require(root+'/lib/data-exchange'),access=require(root+'/lib/workspace-access');
 let recovered=false,released=false;
 X.recover=async()=>{assert.equal(X.pending(base),false);recovered=true;};
 access.enter=()=>{assert(recovered);const folder=path.join(base,'data/.reader/exchange');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'pending.json'),JSON.stringify({schema:1,id:'12345678-1234-1234-1234-123456789abc'}));return()=>{released=true;};};
 access.enterObject=()=>assert.fail('content access must stay blocked');
 global.fetch=()=>assert.fail('no network');
 process.argv=[process.execPath,'cli','1000000101','comments-sent','--sync-only'];
 assert.rejects(require(root+'/lib/cli').main(),/有待恢复的数据合并/).then(()=>assert(released)).catch(error=>{console.error(error);process.exitCode=1;});`;
 const child=require('node:child_process').spawnSync(process.execPath,['-e',code,path.resolve(__dirname,'..')],{env:{...process.env,WEIBO_DESKTOP_PROJECT:b},encoding:'utf8',timeout:5000});
 assert.equal(child.status,0,child.stdout+child.stderr);assert.equal(X.pending(b),true);assert.equal(loaded(b).size,0);
}));
test('exchange: an unindexed legacy applying plan requires explicit reinspection before replacing its old plan',()=>fixture(async({a,b,outside})=>{
 seed(a);const file=await pack(a,outside),check=await X.inspect(b,file),root=path.join(b,'data/.reader/exchange');
 await assert.rejects(X.commit(b,check.id,{inject(phase){if(phase==='before-write')throw Error('old interruption');}}),/old interruption/);
 const oldJob=path.join(root,'transactions',check.id,'job.json'),oldBytes=fs.readFileSync(oldJob),pending=path.join(root,'pending.json');
 fs.unlinkSync(pending);fs.unlinkSync(path.join(root,'pending-pointer-v1.ready'));
 seed(b,[104]);
 assert.equal(X.pending(b),true);assert.equal(fs.existsSync(pending),false);
 await assert.rejects(X.recover(b),/旧合并未登记.*重新检查/);
 await assert.rejects(pack(b,outside),/完成恢复后再导出/);
 assert.deepEqual(JSON.parse(fs.readFileSync(pending)),{schema:1,id:check.id,detachedLegacy:true});
 assert.deepEqual([...loaded(b).keys()],['104']);assert.deepEqual(fs.readFileSync(oldJob),oldBytes);
 const reviewed=await X.inspect(b,file);
 assert.equal(reviewed.summary.reinspection,true);assert.deepEqual([...loaded(b).keys()],['104']);
 assert.equal((await X.commit(b,reviewed.id)).added,3);assert.equal(X.pending(b),false);
 assert.deepEqual([...loaded(b).keys()].sort(),['101','102','103','104']);assert.deepEqual(fs.readFileSync(oldJob),oldBytes);
}));
test('exchange: damaged hashes, path traversal, incompatible versions, oversized entries and symlinks are rejected',()=>fixture(async({a,b,outside})=>{
 seed(a);const p=await pack(a,outside),original=parsePack(p);for(const change of [m=>m.version=99,m=>m.files[0].path='../escape.json',m=>m.files[0].path='/absolute.json',m=>m.files[0].bytes=X.LIMITS.file+1,m=>m.files[0].sha256='0'.repeat(64),m=>m.objects[0].token='forbidden']){const m=structuredClone(original.manifest),bad=path.join(outside,'bad.wrdpack');change(m);malicious(bad,m,original.data);await assert.rejects(X.inspect(b,bad));assert.equal(loaded(b).size,0);}const link=path.join(outside,'link.wrdpack');fs.symlinkSync(p,link);await assert.rejects(X.inspect(b,link));assert.equal(loaded(b).size,0);
}));
test('exchange: concurrent writers prevent merge/export; changed inspection snapshot requires a fresh confirmation',()=>fixture(async({a,b,outside})=>{
 seed(a);const p=await pack(a,outside),check=await X.inspect(b,p),release=require('../lib/workspace-access').enter(b);try{await assert.rejects(X.commit(b,check.id),/仍在保存/);}finally{release();}seed(b,[99]);await assert.rejects(X.commit(b,check.id),/本地数据在检查后/);assert.equal(loaded(b).size,1);
}));
function packet(id,items,max='',since=''){const owner={kind:'user',id:uid},v={schema:1,role:'packet',owner,channel:'sent',query:S.query({count:Math.max(1,items.length),maxId:max,sinceId:since},owner,'sent'),response:S.response({comments:items.map(n=>row(n)),next_cursor:'0'},'sent'),savedAt:'2026-10-30T00:00:00Z',trusted:true};return [id,v];}
function progress(anchor,connections){return {schema:1,role:'progress',owner:{kind:'user',id:uid},channel:'sent',state:{uid,kind:'sent',anchor,checkedAt:'2026-10-30T00:00:00Z',endPolicyVersion:2,baselineUnverified:false,scope:{recentLimit:2,olderHistoryComplete:false}},connections};}
test('exchange progress: a maximum ID or nonempty zero never proves a delta connection',()=>{
 const P=require('../lib/exchange-progress'),packets=new Map([packet('a',[1150],'','1000')]),v=progress('1150',[{lower:'1000',upper:'1150',packets:['a']}]);assert.throws(()=>P.validate(v,packets,{anchor:'1000'}),/未完整接回/);assert.throws(()=>P.validate(v,packets,{anchor:'1200'}),/没有可连接/);
});
test('exchange progress: verified small delta connection is reusable and cannot erase local pending work',()=>{
 const P=require('../lib/exchange-progress'),packets=new Map([packet('a',[1002,1001],'','1000'),packet('b',[],'1000','1000')]),v=progress('1002',[{lower:'1000',upper:'1002',packets:['a']}]);assert.equal(P.validate(v,packets,{anchor:'1000'}).state.anchor,'1002');assert.throws(()=>P.validate(v,packets,{anchor:'1000',pending:{id:'keep'}}),/待续/);
});
function withLegacyProgress(file, destination, value) {
 const {manifest,data}=parsePack(file),bytes=Buffer.from(S.stable(value)),sha256=S.hash(bytes),owner=value.owner;
 manifest.files.push({role:'progress',owner,path:'objects/'+owner.kind+'/'+owner.id+'/progress/'+sha256+'.json',sha256,bytes:bytes.length});
 malicious(destination,manifest,Buffer.concat([data,bytes]));
 return destination;
}
test('exchange: omit checkpoints in new packages and validate without applying old ones',()=>fixture(async({a,b,outside})=>{
 seed(a,[102,101]);const cache=path.join(dir(a),'cache/sent_c200_m0.json'),saved=I.stateFile(dir(a),'sent');
 save(saved,{schema:1,uid,kind:'sent',anchor:'102',checkedAt:'2026-10-30T00:00:00Z',endPolicyVersion:2,origin:'data-update-v1',baselineUnverified:false,scope:{recentLimit:2,olderHistoryComplete:false},proof:[{file:'cache/sent_c200_m0.json',hash:require('../lib/update-progress').token(cache),count:200,maxId:'',sinceId:''}]});
 const bytes=fs.readFileSync(saved),file=await pack(a,outside),manifest=parsePack(file).manifest;
 assert.equal(manifest.files.some(f=>f.role==='progress'),false);
 const hash=manifest.files.find(f=>f.role==='packet').sha256;
 const value={...progress('102',[{initial:true,lower:'',upper:'102',packets:[hash]}]),unknownOutcome:false};
 value.state.origin='data-update-v1';
 const legacy=withLegacyProgress(file,path.join(outside,'legacy.wrdpack'),value),check=await X.inspect(b,legacy);
 assert.equal(check.summary.ignoredProgress,1);
 await X.commit(b,check.id);
 assert.deepEqual([...loaded(b).keys()].sort(),['101','102']);
 assert.equal(I.readState(dir(b),'sent',uid),null);
 assert.deepEqual(fs.readFileSync(saved),bytes);
 assert.equal((await merge(b,legacy)).noChanges,true);
 assert.ok(!parsePack(await pack(b,outside)).manifest.files.some(f=>f.role==='progress'));
 const rejected=withLegacyProgress(file,path.join(outside,'bad-progress.wrdpack'),{...value,connections:[{...value.connections[0],packets:['bad']}]});
 await assert.rejects(X.inspect(b,rejected),/连接证据格式无效/);
}));
test('exchange: an existing imported checkpoint retains its exact response even beside identical native content',()=>fixture(async({a,b,outside})=>{
 seed(a,[102,101]);seed(b,[102,101]);
 const file=await pack(a,outside),manifest=parsePack(file).manifest,hash=manifest.files.find(f=>f.role==='packet').sha256;
 const q=JSON.parse(parsePack(file).data.subarray(0,manifest.files[0].bytes));
 assert.equal(q.role,'packet');
 const ref={file:'cache/exchange-v1/'+hash+'.json',hash,envelope:true,uid,kind:'sent',count:q.query.count,maxId:'',sinceId:'',page:1};
 const localFile=I.stateFile(dir(b),'sent');
 save(localFile,{schema:1,uid,kind:'sent',anchor:'102',checkedAt:'2026-10-30T00:00:00Z',origin:'data-update-v1',importedEvidence:true,proof:[ref]});
 const before=fs.readFileSync(localFile);
 await merge(b,file);
 assert.deepEqual(fs.readFileSync(localFile),before);
 assert.equal(I.restorePacket(ref,dir(b)).raw.comments.length,2);
 assert.equal((await merge(b,file)).noChanges,true);
}));
test('exchange: cross-direction proofs and disconnected or older heads cannot mutate a local checkpoint',()=>fixture(async({a,b,outside})=>{
 seed(a,[102,101]);seed(b,[100]);const local={schema:1,uid,kind:'sent',anchor:'100',checkedAt:'2026-10-29T00:00:00Z',endPolicyVersion:2,pending:{id:'keep-interval'},scope:{recentLimit:1}};save(I.stateFile(dir(b),'sent'),local);const before=fs.readFileSync(I.stateFile(dir(b),'sent'));await merge(b,await pack(a,outside));assert.deepEqual(fs.readFileSync(I.stateFile(dir(b),'sent')),before);assert.equal(loaded(b).size,3);
 const packetValue=packet('a',[102,101])[1];packetValue.channel='received';packetValue.query.kind='received';assert.throws(()=>require('../lib/exchange-progress').validate(progress('102',[{initial:true,upper:'102',packets:['a']}]),new Map([['a',packetValue]]),null),/其他对象或方向/);
}));
test('exchange: multiple users, identical-numbered post and direction indexes survive one transaction without nickname collisions',()=>fixture(async({a,b,outside})=>{
 seed(a,[103]);save(path.join(a,'data/user-comments/.account_names.json'),{[uid]:{folder:uid,nickname:'同名'},[peer]:{folder:peer,nickname:'同名'}});save(path.join(dir(a,peer),'cache/sent_c200_m0.json'),{comments:[row(104,'另一用户',peer)]});save(path.join(a,'data/post-comments',uid,'cache/post-comments_c200_m0.json'),{comments:[{...row(105),status:{idstr:uid,text:'同号博文'}}]});await merge(b,await pack(a,outside));const index=require('../lib/storage').indexRead(path.join(b,'data/user-comments'));assert.ok(index[uid]&&index[peer]);assert.equal(loaded(b).size,1);assert.equal(require('../lib/completeness').loadIndependentArchive(dir(b,peer),'sent',peer).records.size,1);assert.equal(require('../lib/local-database').localPostComments({postId:uid},path.join(b,'data/post-comments',uid)).rows.length,1);
}));
test('exchange: imported bounded pages reuse exact cache queries; date scopes never mix and imported index cannot certify a head',()=>fixture(async({a,b,outside})=>{
 seed(a,[103,102]);save(path.join(dir(a),'cache/sent_c2_m102.json'),{comments:[row(102),row(101)],next_cursor:'0'});await merge(b,await pack(a,outside));const got=require('../lib/storage').getOne({uid,refresh:false},dir(b),'sent',2,'102');assert.equal(got.cached,true);assert.equal(got.raw.comments.length,2);assert.equal(I.readState(dir(b),'sent',uid),null);assert.equal(require('../lib/data-windows').createWindows(dir(b),'sent',uid).point('103').row.content,'正文 103');
}));
test('exchange: image blobs and avatar cache are portable; no profile query is required',()=>fixture(async({a,b,outside})=>{
 seed(a,[103]);const image=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex'),imageHash=S.hash(image);fs.mkdirSync(path.join(dir(a),'images'),{recursive:true});fs.writeFileSync(path.join(dir(a),'images',imageHash+'.png'),image);const profile=path.join(a,'data/.reader/profiles',uid);save(path.join(profile,'identity.json'),{uid,nickname:'目标资料',avatarFile:imageHash+'.png',token:'DO_NOT_EXPORT'});fs.writeFileSync(path.join(profile,imageHash+'.png'),image);const p=await pack(a,outside);assert.ok(!fs.readFileSync(p).toString().includes('DO_NOT_EXPORT'));await merge(b,p);assert.deepEqual(fs.readFileSync(path.join(dir(b),'images',imageHash+'.png')),image);assert.equal(require('../desktop/user-profiles').cached(b,uid).nickname,'目标资料');assert.match(require('../desktop/user-profiles').cached(b,uid).avatarData,/^data:image\/png/);
}));
test('exchange: restart in a new process recovers body-before-index crash and exposes formal records to reports',()=>fixture(async({a,b,outside})=>{
 seed(a);const check=await X.inspect(b,await pack(a,outside));await assert.rejects(X.commit(b,check.id,{inject:(phase,i)=>{if(phase==='after-write'&&i===0)throw Error('simulated process exit');}}));const code="require("+JSON.stringify(require.resolve('../lib/data-exchange'))+").recover(process.argv[1]).then(r=>console.log(JSON.stringify({recovered:r.length}))).catch(e=>{console.error(e.message);process.exit(1)})",child=require('node:child_process').spawnSync(process.execPath,['-e',code,b],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/\"recovered\":1/);assert.equal(require('../desktop/local-view').createLocalView(b).prepare({target:uid,mode:'comments-sent',limit:'200'}).summary.selected,3);
}));
test('exchange: actual desktop dispatcher exports, inspects and commits a scoped package without starting content tasks',()=>fixture(async({a,b,outside})=>{
 seed(a);const messages=[],follow={snapshot:()=>({entries:[]}),release(){},close(){}};let spawns=0;const {runBridge}=require('../desktop/bridge'),bridgeA=runBridge({workspace:a,send:m=>messages.push(m),followService:follow,spawn(){spawns++;throw Error('NO_PAID_REQUEST');}});const filename=path.join(outside,'bridge.wrdpack');await bridgeA.handle({action:'exchangeExport',selection:[{kind:'user',id:uid}],path:filename,requestId:'export'});assert.ok(messages.some(m=>m.type==='exchangeExported'&&m.requestId==='export'),JSON.stringify(messages.filter(m=>m.type.endsWith('Error'))));
 const bridgeB=runBridge({workspace:b,send:m=>messages.push(m),followService:follow,spawn(){spawns++;throw Error('NO_PAID_REQUEST');}});await bridgeB.handle({action:'exchangeInspect',path:filename,requestId:'inspect'});const preview=messages.find(m=>m.type==='exchangeInspected'&&m.requestId==='inspect');assert.equal(preview.summary.added,3);assert.equal(loaded(b).size,0);await bridgeB.handle({action:'exchangeCommit',id:preview.id,requestId:'commit'});assert.ok(messages.some(m=>m.type==='exchangeImported'&&m.requestId==='commit'&&m.added===3));assert.equal(loaded(b).size,3);assert.equal(spawns,0);assert.equal(messages.filter(m=>m.type==='exchangeBusy').at(-1).busy,false);
}));
test('exchange preview transmits bounded labels, warning samples and exact totals without passing evidence',()=>{
 const { preview } = require('../desktop/exchange-presentation');
 const objects=Array.from({length:10000},(_,index)=>({kind:index%2?'post':'user',id:String(90071992547400000n+BigInt(index)),nickname:'"🙂'.repeat(700)}));
 const warnings=Array(10000).fill('🙂"'.repeat(4000));
 const inspection={id:'inspection',manifest:{files:['private content']},packageHash:'private hash',summary:{objects,warnings,added:10}};
 const event=preview(inspection);
 assert.deepEqual(Object.keys(event),['id','summary']);
 assert.equal(event.summary.objectCount,10000);
 assert.equal(event.summary.warningCount,10000);
 assert.equal(event.summary.objects.length,100);
 assert.equal(event.summary.warnings.length,30);
 assert.deepEqual(event.summary.objects[0],{kind:'user',id:objects[0].id,label:'"🙂'.repeat(60)+'…'});
 assert.equal(Array.from(event.summary.warnings[0]).length,241);
 assert.ok(Buffer.byteLength(require('../desktop/wire-format').wireJSON(event))<128*1024);
 assert.equal(event.summary.credits,0);
 assert.equal(inspection.summary.objects[0].nickname,objects[0].nickname);
});
test('exchange: discard keeps a registered inspection or any existing merge cursor',()=>fixture(async({a,b,outside})=>{
 seed(a);
 const file=await pack(a,outside);
 const check=await X.inspect(b,file),other=await X.inspect(b,file);
 const root=path.join(b,'data/.reader/exchange');
 const stage=id=>path.join(root,'transactions',id);
 save(path.join(root,'pending.json'),{schema:1,id:check.id});
 assert.throws(()=>X.discard(b,check.id),/暂存已保留/);
 assert.ok(fs.existsSync(path.join(stage(check.id),'job.json')));
 assert.ok(fs.existsSync(path.join(root,'pending.json')));
 const cursor=path.join(stage(other.id),'progress.json');
 fs.symlinkSync('missing-cursor.json',cursor);
 assert.throws(()=>X.discard(b,other.id),/暂存已保留/);
 assert.ok(fs.lstatSync(cursor).isSymbolicLink());
 fs.unlinkSync(cursor);
 X.discard(b,other.id);
 assert.ok(!fs.existsSync(stage(other.id)));
 assert.ok(fs.existsSync(path.join(root,'pending.json')));
 assert.equal(loaded(b).size,0);
}));
test('exchange: desktop discard is rejected while a confirmation is waiting for the workspace',()=>fixture(async({a,b,outside})=>{
 seed(a);const checked=await X.inspect(b,await pack(a,outside)),events=[],original=X.commit;
 const bridge=require('../desktop/bridge').runBridge({workspace:b,send:event=>events.push(event),followService:{snapshot:()=>({entries:[]}),release(){},close(){}},spawn(){assert.fail('no child for content');}});
 let enter,finish;const entered=new Promise(resolve=>enter=resolve),waiting=new Promise(resolve=>finish=resolve);
 X.commit=async(...args)=>{enter();await waiting;return original(...args);};
 const committing=bridge.handle({action:'exchangeCommit',id:checked.id,requestId:'confirm'});
 try{
  await entered;
  await bridge.handle({action:'exchangeDiscard',id:checked.id,requestId:'discard'});
  assert.match(events.find(event=>event.type==='exchangeError'&&event.requestId==='discard')?.message||'',/正在处理/);
  assert.equal(loaded(b).size,0);
 }finally{finish();await committing;X.commit=original;}
 assert.equal(events.find(event=>event.type==='exchangeImported'&&event.requestId==='confirm')?.added,3);
 assert.equal(loaded(b).size,3);
}));
test('exchange: unknown dates and missing IDs survive as evidence, never as complete independent quota or a successful head',()=>fixture(async({a,b,outside})=>{
 seed(a,[103]);save(path.join(dir(a),'cache/sent_c200_m0.json'),{comments:[{...row(103),created_at:'无法识别'},row(102)],miss_ids:['101'],miss_count:1,next_cursor:'0'});const p=await pack(a,outside),r=await merge(b,p);assert.equal(r.added,1);assert.equal(r.incomplete,1);assert.equal(loaded(b).size,1);assert.equal(I.readState(dir(b),'sent',uid),null);const v=require('../desktop/local-view').createLocalView(b).prepare({target:uid,mode:'comments-sent',limit:'200'});assert.equal(v.summary.selected,1);assert.equal(v.summary.missingBodyCount,2);
}));
test('exchange: committed transactions retain a small journal and remove duplicate staging blobs; unconfirmed packages can be discarded safely',()=>fixture(async({a,b,outside})=>{
 seed(a);const p=await pack(a,outside),check=await X.inspect(b,p),root=path.join(b,'data/.reader/exchange/transactions',check.id);await X.commit(b,check.id);assert.equal(fs.existsSync(path.join(root,'job.json')),true);assert.equal(fs.existsSync(path.join(root,'blobs')),false);const again=await X.inspect(b,p);X.discard(b,again.id);assert.equal(fs.existsSync(path.join(b,'data/.reader/exchange/transactions',again.id)),false);assert.equal(loaded(b).size,3);
}));
test('exchange: imported historical empty terminal remains evidence rather than certifying an unknown prefix',()=>fixture(async({a,b,outside})=>{
 seed(a,[1100]);save(path.join(dir(a),'cache/sent_c1_m1099.json'),{comments:[],next_cursor:'0'});await merge(b,await pack(a,outside));const windows=require('../lib/data-windows').createWindows(dir(b),'sent',uid);assert.equal(windows.at('1099'),null);const index=require('../lib/history').historyIndex(dir(b),'sent',uid);assert.equal(index.read(1,'1099'),null);
}));

test('exchange planning reads only the incoming direction and does not load unrelated historical bodies',()=>fixture(async({a,b,outside})=>{
 seed(a,[103]);seed(b,[90]);save(path.join(dir(b),'cache/received_c200_m0.json'),{comments:[row(91,'other direction',peer)]});
 const original=require('../lib/completeness').loadIndependentArchive,calls=[];
 require('../lib/completeness').loadIndependentArchive=(directory,kind,...args)=>{if(directory===dir(b))calls.push(kind);return original(directory,kind,...args);};
 try{const inspected=await X.inspect(b,await pack(a,outside));assert.equal(inspected.summary.added,1);assert.deepEqual([...new Set(calls)],['sent']);await X.commit(b,inspected.id);assert.equal(loaded(b).size,2);assert.equal(loaded(b,'received').size,1);}finally{require('../lib/completeness').loadIndependentArchive=original;}
}));

test('cooperative exchange planning responds to cancellation before formal writes; the same inspected transaction can safely retry',()=>fixture(async({a,b,outside})=>{
 seed(a,Array.from({length:200},(_,i)=>2000-i));
 for(let p=1;p<8;p++)save(path.join(dir(a),'cache','sent_c200_m'+(2000-p*200)+'.json'),{comments:Array.from({length:200},(_,i)=>row(2000-p*200-i)),next_cursor:'0'});
 const checked=await X.inspect(b,await pack(a,outside)),controller=new AbortController();
 const work=X.commit(b,checked.id,{signal:controller.signal});setImmediate(()=>controller.abort(Error('cancel planning')));
 await assert.rejects(work,/cancel planning/);assert.equal(loaded(b).size,0);assert.equal(X.pending(b),false);
 const recovered=await X.commit(b,checked.id);assert.equal(recovered.added,1600);assert.equal(loaded(b).size,1600);assert.equal(recovered.credits,0);
}));
