'use strict';
const {spawnSync}=require('node:child_process');
const {BASE,ENDPOINTS}=require('./config');
function runCli(args,settings={}){const direct=process.env.WEIBO_DESKTOP_CLI,env={...process.env};
 // The native app pins NODE_ENV=production. An explicitly selected terminal
 // development environment remains available; production never inherits TLS-off.
 if(env.NODE_ENV!=='development'){env.NODE_ENV='production';env.NODE_TLS_REJECT_UNAUTHORIZED='1';}
 const r=spawnSync(direct?process.execPath:process.platform==='win32'?'npx.cmd':'npx',direct?[direct,...args]:['--no-install','weibo-cli',...args],{cwd:BASE,env,encoding:'utf8',timeout:settings.timeout??180000,maxBuffer:100*1024*1024});
 if(r.error)throw Error(`调用 npx 失败：${r.error.message}`);
 if(r.status!==0){const capture=require('./service-rejection').classify(r,args);if(capture)throw Object.assign(Error(require('./service-rejection').message),{code:capture.code,serviceRejectionCapture:capture});throw Error(`CLI 退出码 ${r.status}：${(r.stderr||r.stdout||'').slice(0,500)}`);}
 return r.stdout;
}
function preflight(o,requests){
 if((o.update||o.syncOnly)&&!o.offline&&!o.dryRun){
  const updateSince={};let commentsMentionCursor=true;o.endpointMetadata=new Map();
  for(const {kind,budget}of requests){
   if(budget<=0)continue;const [group,action]=ENDPOINTS[kind].command;let command=null;
   try{const raw=JSON.parse(runCli(['commands','show',group,action,'--output','json'],{timeout:10000}));const c=raw.command||raw;if(c.group===group&&c.action===action)command=c;}catch{}
   o.endpointMetadata.set(kind,command);const flags=new Set((command?.flags||[]).map(f=>f.name));
   updateSince[kind]=command?.method==='GET'&&flags.has('since_id');
   if(kind==='mentions-comments'&&command)commentsMentionCursor=flags.has('max_id');
  }
  return {updateSince,commentsMentionCursor};
 }
 if(Number.isFinite(o.beforeMs)&&!o.offline&&!o.dryRun){
  for(const {kind,budget} of requests){
   if(budget<=0)continue;
   const [group,action]=ENDPOINTS[kind].command;
   const details=JSON.parse(runCli(['commands','show',group,action,'--output','json']));
   const command=details.command||details,flags=new Set((command.flags||[]).map(flag=>flag.name));
   const required=['uid','count','page','max_id'];
   if(command.group!==group||command.action!==action||command.method!=='GET'||!required.every(flag=>flags.has(flag)))throw Error(`当前 CLI 未确认支持 ${group} ${action} 的历史分页参数；已在读取前停止`);
  }
  return {commentsMentionCursor:true};
 }
 // This particular endpoint was not documented by the user's screenshots;
 // check it exists and exposes the required parameters BEFORE any paid requests.
 if(o.offline||o.dryRun||!requests.some(x=>x.kind==='mentions-comments'&&x.budget>0))return;
 const details=runCli(['commands','show','comments','mentions/other']);
 if(!details.includes('comments mentions/other')||!details.includes('--uid')||!details.includes('--count')){
    throw Error('当前 CLI 没有确认支持 comments/mentions/other 的 --uid/--count 参数；已在付费请求前停止。\n'+details.slice(0,600));
 }
 const hasCursor=details.includes('--max_id');
 
 return {commentsMentionCursor:hasCursor};
}
module.exports={runCli,preflight};
