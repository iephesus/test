'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {runBridge}=require('../desktop/bridge'),uid='1234567890';
const meta={command:{group:'users',action:'show_batch/other',method:'GET',flags:[{name:'uids'}],price_type:'per_record',pricing:{configured:true,currency:'credits',unit_price:3}}};
async function fixture(run){const base=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-boundary-'));const a=path.join(base,'a'),b=path.join(base,'b');for(const w of[a,b]){fs.mkdirSync(path.join(w,'data'),{recursive:true});fs.writeFileSync(path.join(w,'data/.layout-v2'),'2');}try{return await run(a,b);}finally{fs.rmSync(base,{recursive:true,force:true});}}
const follow={snapshot:()=>({entries:[]}),close(){},release(){}};
test('delayed profile response persists in its original workspace; stale requests cannot write into the newly selected workspace',()=>fixture(async(a,b)=>{
 let finish;const events=[];let lookups=0;const bridge=runBridge({workspace:a,send:e=>events.push(e),followService:follow,spawn(){assert.fail('remote child forbidden');},profileOptions:{lookupLocal:async()=>null,run:async args=>{if(args[0]==='commands')return meta;lookups++;return new Promise(resolve=>finish=resolve);}}});
 const work=bridge.handle({action:'userAdd',uid,workspace:a,requestId:'add'});while(!finish)await new Promise(setImmediate);
 await bridge.handle({action:'workspace',path:b,workspace:a});assert.equal(events.filter(e=>e.type==='library').at(-1).workspace,b);
 finish({users:[{idstr:uid,screen_name:'迟到的 A'}]});await work;
 const receipts=fs.readdirSync(path.join(a,'data/.reader/profiles',uid)).filter(n=>n.startsWith('lookup-'));const stored=JSON.parse(fs.readFileSync(path.join(a,'data/.reader/profiles',uid,receipts[0])));
 assert.equal(stored.status,'saved');assert.equal(stored.response.users[0].idstr,uid);assert.ok(stored.responseHash);
 assert.equal(fs.existsSync(path.join(b,'data/.reader/profiles',uid)),false);assert.ok(!events.some(e=>e.type==='userProfile'&&e.workspace===b));
 await bridge.handle({action:'userAdd',uid:'9876543210',workspace:a,requestId:'stale'});assert.equal(events.at(-1).workspace,a);assert.match(events.at(-1).message,/目录已改变/);assert.equal(fs.existsSync(path.join(b,'data/.reader/users.json')),false);assert.equal(lookups,1);
}));
test('profile batch blocks directory switching until responses are saved; no later user is queried in a different workspace',()=>fixture(async(a,b)=>{
 const U=require('../desktop/user-workspace');U.add(a,uid);U.add(a,'9876543210');let finish;const calls=[],events=[];
 const bridge=runBridge({workspace:a,send:e=>events.push(e),followService:follow,spawn(){assert.fail('remote child forbidden');},profileOptions:{lookupLocal:async()=>null,run:async args=>{if(args[0]==='commands')return meta;calls.push(args[3]);return new Promise(resolve=>finish=resolve);}}});
 const work=bridge.handle({action:'profilesRefresh',uids:[uid,'9876543210'],workspace:a});while(!finish)await new Promise(setImmediate);
 await bridge.handle({action:'workspace',path:b,workspace:a});assert.match(events.at(-1).message,/不能更换/);finish({users:[]});await work;assert.deepEqual(calls,[uid]);assert.equal(events.filter(e=>e.type==='library').at(-1).workspace,a);
}));
test('automatic collection stop creates a cooperative stop marker instead of interrupting an in-flight child',()=>fixture(async(a)=>{
 let launch;const children=[],events=[];const service={...follow,observe(){},finish(){return {alreadySettled:true};}};
 // Use the real scheduler boundary without running timers or remote commands.
 const original=require('../desktop/auto-follow').createAutoFollow;
 require('../desktop/auto-follow').createAutoFollow=(base,options)=>{launch=options.launch;return service;};
 try{
  const bridge=runBridge({workspace:a,send:e=>events.push(e),spawn(){const c=new EventEmitter();c.pid=98765;c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdio=[null,c.stdout,c.stderr,new PassThrough()];children.push(c);return c;}});bridge.bootstrap();
  const id=require('node:crypto').randomUUID();launch({id,uid,mode:'sent',roundLimit:10});await bridge.handle({action:'stop',workspace:a});
  const stop=require('../lib/auto-follow-budget').roundFile(a,id)+'.stop';assert.match(JSON.parse(fs.readFileSync(stop)).reason,/保存当前响应/);assert.equal(children.length,1);
  children[0].stdio[3].write(JSON.stringify({type:'summary',syncOnly:true,uid,records:1,cancelled:true})+'\n');children[0].emit('close',0,null);assert.equal(events.filter(e=>e.type==='finished'&&e.automatic).length,1);assert.equal(fs.existsSync(stop),false);
 }finally{require('../desktop/auto-follow').createAutoFollow=original;}
}));
test('corrupt persistent user registry is reported and never overwritten by add/view',()=>fixture(a=>{
 const U=require('../desktop/user-workspace'),file=U.registry(a);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{truncated');const bytes=fs.readFileSync(file);
 assert.throws(()=>U.add(a,uid),/原文件保留/);assert.throws(()=>U.viewed(a,uid),/原文件保留/);assert.deepEqual(fs.readFileSync(file),bytes);
}));

test('confirmed deletion waits behind any real workspace writer and preserves its confirmation for retry',()=>fixture(async(a)=>{
 require('../desktop/user-workspace').add(a,uid);const events=[],bridge=runBridge({workspace:a,send:e=>events.push(e),followService:follow,spawn(){assert.fail('remote forbidden');}});
 await bridge.handle({action:'userDeletePlan',uid,requestId:'plan',workspace:a});const plan=events.find(e=>e.type==='userDeletePlan');assert.ok(plan.token);
 const release=require('../lib/workspace-access').enter(a);try{await bridge.handle({action:'userDeleteConfirm',uid,token:plan.token,workspace:a,requestId:'confirm-busy'});assert.equal(events.at(-1).requestId,'confirm-busy');assert.equal(events.at(-1).workspace,a);assert.match(events.at(-1).message,/仍在保存/);assert.equal(require('../desktop/user-workspace').home(a,[],[]).length,1);}finally{release();}
 await bridge.handle({action:'userDeleteConfirm',uid,token:plan.token,workspace:a,requestId:'confirm'});assert.ok(events.some(e=>e.type==='userDeleted'&&e.requestId==='confirm'&&e.workspace===a));assert.equal(require('../desktop/user-workspace').home(a,[],[]).length,0);
}));
