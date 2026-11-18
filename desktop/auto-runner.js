'use strict';
const {clean}=require('../lib/diagnostic-text');
// Only the trusted desktop scheduler launches this child. No automatic reports.
const path=require('node:path');
const {BASE}=require('../lib/config'),{createBudget,atomic,read,safety}=require('../lib/auto-follow-budget'),{emit}=require('../lib/events');
const id=process.argv[2];let guard,release,releaseObject;
try{
 if(require('../lib/data-exchange').pending(BASE))throw Error('有待恢复的数据合并，请先打开应用完成恢复');release=require('../lib/workspace-access').enter(BASE);
 guard=createBudget(BASE,id);const job=guard.job;
 if(job.requireWorkerBinding){const birth=require('../lib/process-lease').processBirth(process.pid),until=performance.now()+3000;let ready=false;do{const current=read(guard.file),worker=current?.worker;if(current?.id!==job.id||current.uid!==job.uid||(current.targetKind||'user')!==(job.targetKind||'user')||current.requireWorkerBinding!==true)throw safety('AUTO_WORKER_BINDING','原自动任务身份已变化，未发起内容请求');if(worker){if(worker.schema!==1||worker.pid!==process.pid||worker.pgid!==process.pid||!birth||worker.birth!==birth||worker.closedAt||!Number.isFinite(Date.parse(worker.startedAt)))throw safety('AUTO_WORKER_BINDING','自动任务进程绑定无法核实，未发起内容请求');ready=true;break;}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}while(performance.now()<until);if(!ready)throw safety('AUTO_WORKER_BINDING','自动任务进程绑定尚未保存，未发起内容请求');}
 releaseObject=require('../lib/workspace-access').enterObject(BASE,job.targetKind==='post'?'post':'user',job.postId||job.uid);
 if(job.targetKind==='post'){require('../lib/post-subscription').run(job,guard);return;}
 const cap=Math.min(job.roundLimit,require('../lib/auto-follow-budget').MAX_CLI_ROUND_RETURNS);
 const runMode=job.deferredKinds?.length&&job.kinds?.length===1?job.kinds[0]:job.mode,runLimit=job.mode==='both'&&runMode!=='both'?(runMode==='sent'?Math.ceil(cap/2):Math.floor(cap/2)):cap;
 const o=require('../lib/options').options([job.uid,{sent:'comments-sent',received:'comments-received',both:'comments-both'}[runMode],'--sync-only','--update','--limit',String(runLimit)]);
 o.autoFollow=true;o.autoRoundId=id;o.autoGuard=guard;
 require('../lib/user-comments').runUserComments(o);
}catch(error){
 const reason=clean(require('../lib/terminal-report').conciseError(error));
 if(guard)try{const value=read(guard.file);value.safetyCode=error.code||'AUTO_FAILED';value.reason=reason;atomic(guard.file,value);}catch(saveError){console.error('失败状态未能保存，原有数据及费用证据保留：'+saveError.message);}
 emit('autoSafety',{code:error.code||'AUTO_FAILED',message:reason});console.error(reason);process.exitCode=1;
}finally{try{releaseObject?.();}finally{release?.();}}
