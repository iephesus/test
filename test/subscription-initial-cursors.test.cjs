'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const B=require('../lib/auto-follow-budget'),I=require('../lib/incremental'),J=require('../lib/request-journal'),{createAutoFollow}=require('../desktop/auto-follow');
const {fixture,withEngine,uid,row,save,round}=require('./subscription-fixture.cjs');
const flag=(call,key)=>call.includes(key)?call[call.indexOf(key)+1]:'';
for(const mode of ['body','empty-chain','repeated-cursor','missing-evidence','altered-receipt'])test('initial automatic check uses only an unbroken exact saved cursor chain: '+mode,()=>fixture(base=>{
 const values=[row(299,'received'),row(298,'received'),row(297,'received')],f=withEngine(base,{received:values}),kind='received';
 fs.rmSync(path.join(f.dir,'cache'),{force:true,recursive:true});
 const shim=path.join(base,'mock-cli.js'),original=fs.readFileSync(shim,'utf8'),marker="const since=flag('--since_id')";assert(original.includes(marker));
 if(mode!=='body'){
  const hook=`if(!flag('--since_id')){const max=flag('--max_id');const first=JSON.stringify({comments:[],next_cursor_str:'301'${mode==='missing-evidence'?',miss_count:1,miss_ids_str:["310"]':''}});if(!max){console.log(first);process.exit();}if(max==='301'){console.log(JSON.stringify({comments:[],next_cursor_str:'${mode==='repeated-cursor'?'301':'300'}'}));process.exit();}}`;
  save(shim,original.replace(marker,hook+marker));
 }
 if(mode==='altered-receipt'){
  const storage=path.join(base,'lib/storage.js'),text=fs.readFileSync(storage,'utf8'),wire='verifyWindow();opts.autoGuard?.validateAutomaticWire?.(reservation,query,context);wireAttempt=true';assert(text.includes(wire));
  save(storage,text.replace(wire,`if(query.kind==='received'&&query.maxId==='301'){const root=path.join(dir,'cache/request-journal');for(const n of fs.readdirSync(root))if(n.endsWith('.response.json'))fs.appendFileSync(path.join(root,n),' ');}`+wire));
 }
 const jobs=[],results=[];let at=Date.now()+10000,s;
 s=createAutoFollow(base,{now:()=>at,random:()=>0,setTimer:()=>null,launch:r=>{jobs.push(r);const out=f.run(r,{at});results.push(out);s.finish(r.id,{summary:out.summary,code:out.status,reason:out.stderr});}});
 const next=()=>{at=Date.parse(s.snapshot().entries[0].nextCheckAt)+1;s.tick();};
 try{
  s.save({uid,mode:kind,frequency:'fixed',interval:1,roundLimit:4,dailyBudget:100,enabled:true},'enable');next();
  const calls=f.contentCalls().map(a=>flag(a,'--max_id'));
  if(['repeated-cursor','missing-evidence','altered-receipt'].includes(mode)){
   assert.deepEqual(calls,mode==='repeated-cursor'?['','301']:['']);assert(!I.readState(f.dir,kind,uid)?.checkedAt);assert(s.snapshot().entries[0].enabled);
   assert(results[0].summary?.incomplete);
   if(mode==='altered-receipt')assert(B.read(B.roundFile(base,jobs[0].id)).requests.some(q=>q.wireOutcome==='not-sent'));
   return;
  }
  assert.deepEqual(calls,mode==='body'?['','298']:['','301','300']);
  const state=I.readState(f.dir,kind,uid);assert.equal(state.anchor,'299');assert.equal(state.endPolicyVersion,2);assert(state.connection||state.connectedProof);
  const connection=state.connectedProof||B.read(path.join(f.dir,'cache',state.connection.file)),refs=connection.packets;
  assert.equal(J.verifySavedResponse(f.dir,refs[0]).query.maxId,'');assert.deepEqual(refs.map(ref=>J.verifySavedResponse(f.dir,ref).query.maxId),calls);
  const archive=()=>require('../lib/completeness').loadIndependentArchive(f.dir,kind,uid).records;
  assert.equal(archive().get('299').row.content,'独立评论 299');
  const old=Object.fromEntries(refs.map(ref=>[ref.file,fs.readFileSync(path.join(f.dir,ref.file))]));
  const cfg=JSON.parse(fs.readFileSync(f.conf));save(f.conf,{...cfg,received:[row(310,kind),...values]});next();
  assert.equal(flag(f.contentCalls().at(-1),'--since_id'),'299');assert.equal(archive().get('310').row.content,'独立评论 310');
  assert.equal(require('../lib/follow-inbox').summary(base,uid).unread>0,true);assert.equal(I.readState(f.dir,kind,uid).anchor,'310');
  for(const [file,bytes]of Object.entries(old))assert.deepEqual(fs.readFileSync(path.join(f.dir,file)),bytes);
 }finally{s.close();s.release();}
}));

for(const initial of [false,true])test('automatic latest check stops before a page beginning at an already saved record: '+(initial?'initial':'established'),()=>fixture(base=>{
 const kind='received',f=withEngine(base,{received:[row(330,kind),row(320,kind),row(310,kind)]});
 save(path.join(f.dir,'cache/received_c1_m320.json'),{comments:[row(320,kind)],next_cursor_str:'319'});
 if(initial)fs.unlinkSync(I.stateFile(f.dir,kind));
 const job=round(base,{mode:kind,kinds:[kind]});
 const result=f.run(job);
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(f.contentCalls().map(call=>[flag(call,'--count'),flag(call,'--max_id')]),[['1','']]);
 const charged=B.read(B.roundFile(base,job.id)).requests;
 assert.deepEqual(charged.map(q=>[q.returned,q.estimatedCredits]),[[1,3]]);
 const state=I.readState(f.dir,kind,uid);
 if(initial)assert.equal(state.anchor,'330');
 else{
  assert.equal(state.anchor,'200');
  assert.equal(state.pending.head,'330');
  assert.equal(state.pending.cursor,'320');
  const next=round(base,{mode:kind,kinds:[kind]});
  assert.equal(f.run(next).status,0);
  assert.equal(flag(f.contentCalls().at(-1),'--since_id'),'330');
  assert.equal(B.read(B.roundFile(base,next.id)).requests[0].estimatedCredits,0);
 }
 const archived=require('../lib/completeness').loadIndependentArchive(f.dir,kind,uid).records;
 assert(archived.has('330')&&archived.has('320')&&!archived.has('310'));
}));

test('possible overlap narrows the continuation to one row and retains the unverified older interval',()=>fixture(base=>{
 const kind='received',f=withEngine(base,{received:[row(330,kind),row(327,kind),row(325,kind),row(320,kind),row(310,kind)]});
 save(path.join(f.dir,'cache/received_c1_m320.json'),{comments:[row(320,kind)],next_cursor_str:'319'});
 const job=round(base,{mode:kind,kinds:[kind]});
 const result=f.run(job);
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(f.contentCalls().map(call=>[flag(call,'--count'),flag(call,'--max_id')]),[['1',''],['1','327'],['1','325']]);
 assert.deepEqual(B.read(B.roundFile(base,job.id)).requests.map(q=>q.estimatedCredits),[3,3,3]);
 const state=I.readState(f.dir,kind,uid);
 assert.equal(state.anchor,'200');
 assert.equal(state.pending.cursor,'320');
 assert.equal(state.pending.packets.length,3);
}));

for(const closes of [true,false])test('subscription replays matching ranges locally and stops at '+(closes?'the verified checkpoint':'the first unproven range'),()=>fixture(base=>{
 const kind='received',f=withEngine(base,{received:[row(330,kind),row(320,kind),row(315,kind),row(310,kind),row(300,kind)]});
 const pages=[{upper:'320',ids:[320,315],next:'310',lower:'200'},{upper:'310',ids:[310,300],next:'200',lower:closes?'200':'198'}];
 const receipts=pages.map(page=>{
  const query={uid,kind,count:2,maxId:page.upper,sinceId:page.lower,page:1,taskId:require('node:crypto').randomUUID()};
  const raw={comments:page.ids.map(id=>row(id,kind)),next_cursor_str:page.next};
  const request=J.begin(f.dir,query);
  J.receive(request,JSON.stringify(raw),'');
  const receipt=J.save(request,raw,'');
  return [receipt.file,fs.readFileSync(receipt.file)];
 });
 const job=round(base,{mode:kind,kinds:[kind]});
 const result=f.run(job);
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(f.contentCalls().map(call=>[flag(call,'--count'),flag(call,'--max_id')]),[['1','']]);
 assert.deepEqual(B.read(B.roundFile(base,job.id)).requests.map(q=>q.estimatedCredits),[3]);
 assert.equal(result.summary.addedRecords,1);
 const state=I.readState(f.dir,kind,uid);
 if(closes){
  assert.equal(state.anchor,'330');
  assert.equal(state.pending,null);
  const proof=B.read(path.join(f.dir,'cache',state.connection.file));
  assert.deepEqual(proof.packets.map(ref=>[ref.maxId,!!ref.localReplay]),[['',false],['320',true],['310',true]]);
  const checked=require('../lib/regular-progress').connection(f.dir,kind,uid,{schema:1,uid,kind,id:proof.id,anchor:proof.lower,head:proof.upper,deltaComplete:true,phase:'body',since:true,deltaPackets:proof.packets});
  assert.equal(checked?.upper,'330');
 }else{
  assert.equal(state.anchor,'200');
  assert.equal(state.pending.cursor,'310');
  assert.equal(state.pending.packets.length,2);
 }
 for(const [file,bytes]of receipts)assert.deepEqual(fs.readFileSync(file),bytes);
}));
