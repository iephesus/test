'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const B=require('../lib/auto-follow-budget'),{createAutoFollow}=require('../desktop/auto-follow'),{withEngine,uid,row,round}=require('./subscription-fixture.cjs'),lease=require('../lib/process-lease');
function fixture(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'reader-worker-binding-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {base,...withEngine(base,{sent:[row(101)]})};}
function childRun(f,r,{bind,delay=0,at}={}){return new Promise((resolve,reject)=>{const clock=path.join(f.base,'worker-clock.cjs');if(at!=null)fs.writeFileSync(clock,'Date.now=()=>'+at+';');const c=spawn(process.execPath,[...(at!=null?['--require',clock]:[]),path.join(f.base,'desktop/auto-runner.js'),r.id],{cwd:f.base,detached:true,env:{...process.env,WEIBO_DESKTOP_PROJECT:f.base,WEIBO_DESKTOP_CLI:path.join(f.base,'mock-cli.js'),WEIBO_DESKTOP_EVENTS:'1'},stdio:['ignore','pipe','pipe','pipe']});let stdout='',stderr='',events='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);c.stdio[3].on('data',b=>events+=b);c.on('error',reject);if(bind)setTimeout(()=>{try{bind(c);}catch(error){try{c.kill('SIGTERM');}catch{}reject(error);}},delay);c.on('close',(code,signal)=>resolve({code,signal,c,stdout,stderr,events:events.split('\n').filter(Boolean).map(s=>JSON.parse(s))}));});}
test('real worker waits for the durable exact process binding, then actually requests and saves; close is explicit only',async t=>{
 const f=fixture(t);assert.equal(f.run(round(f.base)).status,0);let at=Date.now()+10000,r;const s=createAutoFollow(f.base,{now:()=>at,setTimer:()=>null,launch:x=>r=x});t.after(()=>{s.close();s.release();});s.save({uid,mode:'sent',frequency:'fixed',interval:1,roundLimit:10,dailyBudget:3000,enabled:true},'enable');at+=2000;s.tick();s.prepareWorker(r.id);assert.equal(B.read(B.roundFile(f.base,r.id)).requireWorkerBinding,true);assert.equal(B.read(B.roundFile(f.base,r.id)).worker,undefined);const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(102),row(101)];fs.writeFileSync(f.conf,JSON.stringify(cfg));let binding;const result=await childRun(f,r,{delay:125,bind:c=>{binding=s.bindWorker(r.id,{schema:1,pid:c.pid,pgid:c.pid,birth:lease.processBirth(c.pid),startedAt:r.startedAt});}});assert.equal(result.code,0,result.stderr);const before=B.read(B.roundFile(f.base,r.id));assert.equal(before.worker.pid,result.c.pid);assert.equal(before.worker.closedAt,undefined,'a summary or exit code does not assert child close');s.workerClosed(r.id,binding,new Date(at).toISOString());const closed=B.read(B.roundFile(f.base,r.id));assert.equal(closed.worker.closedAt,new Date(at).toISOString());assert.equal(closed.worker.birth,binding.birth);const summary=result.events.find(e=>e.type==='summary');assert(summary?.sources.some(v=>v.kind==='sent'&&v.update?.caughtUp));s.finish(r.id,{summary,code:result.code});assert.equal(require('../lib/incremental').readState(f.dir,'sent',uid).anchor,'102');assert(B.read(B.roundFile(f.base,r.id)).worker.closedAt);
});
test('an ended worker that reserved before writing its request permits one new trusted observation and preserves the original fee',async t=>{
 const f=fixture(t),I=require('../lib/incremental'),J=require('../lib/request-journal'),R=require('../desktop/subscription-recovery'),C=require('../lib/subscription-continuous');
 assert.equal(f.run(round(f.base)).status,0);assert.equal(I.readState(f.dir,'sent',uid).anchor,'101');
 const journal=path.join(f.base,'lib/request-journal.js'),source=fs.readFileSync(journal,'utf8');
 fs.writeFileSync(journal,source+`\nconst originalBegin=module.exports.begin;module.exports.begin=(dir,query,reservation)=>{if(reservation)process.exit(23);return originalBegin(dir,query,reservation);};\n`);
 let at=Date.now()+10000,r;
 const s=createAutoFollow(f.base,{now:()=>at,setTimer:()=>null,random:()=>0,launch:value=>r=value});t.after(()=>{s.close();s.release();});
 s.save({uid,mode:'sent',frequency:'fixed',interval:1,roundLimit:10,dailyBudget:3000,timeZone:'UTC',enabled:true},'enable');at+=2000;s.tick();
 const originalRound=r;
 async function bound(job){
  s.prepareWorker(job.id);let binding;
  const result=await childRun(f,job,{at,delay:60,bind:c=>{binding=s.bindWorker(job.id,{schema:1,pid:c.pid,pgid:c.pid,birth:lease.processBirth(c.pid),startedAt:job.startedAt});}});
  s.workerClosed(job.id,binding,new Date(at).toISOString());s.finish(job.id,{code:result.code,summary:result.events.find(e=>e.type==='summary'),reason:result.stderr});
  return result;
 }
 const before=f.contentCalls().length,stopped=await bound(originalRound);assert.equal(stopped.code,23,stopped.stderr);assert.equal(f.contentCalls().length,before);
 fs.writeFileSync(journal,source);
 const originalFile=B.roundFile(f.base,originalRound.id),old=B.read(originalFile),oldBytes=fs.readFileSync(originalFile),q=old.requests[0];
 assert.equal(old.worker.pid,stopped.c.pid);assert.equal(q.status,'unknown');assert.equal(q.reservedCredits,3);assert.deepEqual(J.subscriptionRequests(f.dir,old.id,q.id),[]);
 const entry=s.snapshot().entries[0],check=()=>R.inspect(f.base,entry,f.dir),query={uid,kind:'sent',count:q.count,maxId:q.maxId,sinceId:q.sinceId,page:1,taskId:require('node:crypto').randomUUID()},raw={comments:[row(102)],next_cursor_str:'0'},billingReservation={roundId:old.id,id:q.id};
 const blocked=()=>{const checked=check();assert.deepEqual(checked.blockedKinds,['sent']);assert.equal(R.automaticRecovery(f.base,entry,f.dir,checked,['sent'],{now:()=>at}),null);assert.equal(f.contentCalls().length,before);};
 const makeFile=suffix=>path.join(J.folder(f.dir),require('node:crypto').randomUUID()+suffix);
 const orphan=makeFile('.received.json'),orphanFormal=makeFile('.response.json'),wrong=makeFile('.request.json');
 for(const [file,body] of [[orphan,{schema:1,query,billingReservation,responseText:JSON.stringify(raw)}],[orphanFormal,{schema:1,query,response:raw}],[wrong,{schema:1,query,status:'unknown',billingReservation:{...billingReservation,roundId:require('node:crypto').randomUUID()}}]]){
  fs.writeFileSync(file,JSON.stringify(body));try{blocked();}finally{fs.unlinkSync(file);}
 }
 B.atomic(originalFile,{...old,status:'running',worker:{schema:1,pid:process.pid,pgid:process.pid,birth:lease.processBirth(process.pid),startedAt:old.worker.startedAt}});
 try{blocked();}finally{fs.writeFileSync(originalFile,oldBytes);}
 assert.equal(C.fact(f.base,f.dir,old,q)?.missingRequest?.lower,'101');assert.deepEqual(check().recoveryKinds,['sent']);
 const config=JSON.parse(fs.readFileSync(f.conf));config.sent=[row(102)];fs.writeFileSync(f.conf,JSON.stringify(config));
 at=Date.parse(s.snapshot().entries[0].nextCheckAt)+1;s.tick();assert.notEqual(r.id,old.id);
 const fresh=await bound(r),saved=B.read(B.roundFile(f.base,r.id));assert.equal(fresh.code,0,fresh.stderr);
 assert.equal(f.contentCalls().length,before+1);assert.equal(saved.requests[0].automaticRecovery.windowId,r.id);assert.equal(saved.requests[0].sinceId,'101');assert.equal(saved.requests[0].returned,1);
 const inbox=require('../lib/follow-inbox'),unread=()=>inbox.unreadIds(inbox.view(f.base,uid));
 assert.equal(I.readState(f.dir,'sent',uid).anchor,'102');assert(unread().has('102'));
 const firstNew=r.id;config.sent=[row(103)];fs.writeFileSync(f.conf,JSON.stringify(config));
 at=Date.parse(s.snapshot().entries[0].nextCheckAt)+1;s.tick();assert.notEqual(r.id,firstNew);
 const later=await bound(r);assert.equal(later.code,0,later.stderr);assert.equal(f.contentCalls().length,before+2);
 assert.equal(B.read(B.roundFile(f.base,r.id)).requests[0].sinceId,'102');assert.equal(I.readState(f.dir,'sent',uid).anchor,'103');
 assert(unread().has('102'));assert(unread().has('103'));
 const archive=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records;
 for(const id of ['102','103'])assert.equal(archive.get(id).row.content,'独立评论 '+id);
 assert.deepEqual(fs.readFileSync(originalFile),oldBytes);assert.deepEqual(J.subscriptionRequests(f.dir,old.id,q.id),[]);assert.equal(B.usage(f.base,uid,q.day).reservedCredits,3);
 const usage=B.usage(f.base,uid,B.localDay(at,'UTC'));assert.equal(usage.reservedCredits+usage.historicalUnverifiedCredits,3);
});
for(const variant of['missing','wrong'])test('a '+variant+' worker binding produces zero service calls and cannot mark itself closed',async t=>{
 const f=fixture(t);assert.equal(f.run(round(f.base)).status,0);let at=Date.now()+10000,r;const s=createAutoFollow(f.base,{now:()=>at,setTimer:()=>null,launch:x=>r=x});t.after(()=>{s.close();s.release();});s.save({uid,mode:'sent',frequency:'fixed',interval:1,roundLimit:10,dailyBudget:3000,enabled:true},'enable');at+=2000;s.tick();s.prepareWorker(r.id);if(variant==='wrong'){const x=B.read(B.roundFile(f.base,r.id));x.worker={schema:1,pid:1,pgid:1,birth:'not-this-worker',startedAt:r.startedAt};B.atomic(B.roundFile(f.base,r.id),x);}const before=fs.readFileSync(f.calls,'utf8'),result=await childRun(f,r);assert.equal(result.code,1);assert.match(result.stderr,/进程绑定/);assert.equal(fs.readFileSync(f.calls,'utf8'),before,'even metadata and account service calls stay zero');assert.equal(B.read(B.roundFile(f.base,r.id)).requests.length,0);assert.equal(B.read(B.roundFile(f.base,r.id)).worker?.closedAt,undefined);assert.throws(()=>s.workerClosed(r.id,{pid:1,birth:'incorrect',startedAt:r.startedAt}),/不属于/);
});
for(const fail of[false,true])test('actual bridge '+(fail?'refuses an unverified spawned worker before content':'binds its spawned worker and records close before finalization'),async t=>{
 const f=fixture(t);assert.equal(f.run(round(f.base)).status,0);const config=JSON.parse(fs.readFileSync(f.conf));config.sent=[row(102),row(101)];fs.writeFileSync(f.conf,JSON.stringify(config));const before=f.contentCalls().length,events=[],children=[],birth=lease.processBirth;let finished;
 const done=new Promise(resolve=>finished=resolve),bridge=require('../desktop/bridge').runBridge({workspace:f.base,send:e=>{events.push(e);if(e.type==='finished'&&e.automatic)finished(e);},spawn:(command,args,options)=>{const child=spawn(command,args,{...options,env:{...options.env,WEIBO_DESKTOP_CLI:path.join(f.base,'mock-cli.js')}});children.push(child);return child;}});
 if(fail)lease.processBirth=pid=>children.some(child=>child.pid===pid)?null:birth(pid);
 try{await bridge.handle({action:'bootstrap'});await bridge.handle({workspace:f.base,action:'followConfigure',intent:'enable',requestId:'isolated-config',settings:{uid,mode:'sent',frequency:'fixed',interval:1,roundLimit:10,dailyBudget:3000,enabled:true}});const timeout=setTimeout(()=>finished(null),12000),result=await done;clearTimeout(timeout);assert(result,'real automatic child must complete through bridge close/finalization');await bridge.handle({workspace:f.base,action:'followPause',uid});assert.equal(children.length,1);const started=events.find(e=>e.type==='started'&&e.automatic),saved=B.read(B.roundFile(f.base,started.id));assert.equal(saved.requireWorkerBinding,true);
  if(fail){assert.equal(f.contentCalls().length,before);assert.equal(saved.worker,undefined);assert.equal(saved.requests.length,0);assert.equal(saved.safetyCode,'AUTO_WORKER_BINDING');}else{assert.equal(saved.worker.pid,children[0].pid);assert(saved.worker.birth);assert(saved.worker.closedAt);assert.equal(require('../lib/incremental').readState(f.dir,'sent',uid).anchor,'102');assert(f.contentCalls().length>before);}
 }finally{lease.processBirth=birth;for(const child of children)try{child.kill('SIGKILL');}catch{}const empty=path.join(f.base,'another-isolated-workspace');fs.mkdirSync(empty);await bridge.handle({workspace:f.base,action:'workspace',path:empty});}
});
