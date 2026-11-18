'use strict';
const {COMMANDS,commandName}=require('./config');
const {hasBefore,parseBefore,parsePostTarget}=require('./core');
const {readLimit,readPageSize,assignCount}=require('./limits');
const dates=require('./date-range');
function sharedOption(o,flag){
 const property={'--offline':'offline','--refresh':'refresh','--dry-run':'dryRun','--open':'openReport','--verbose':'verbose','--database':'database','--sync-only':'syncOnly','--new-only':'newOnly','--unread':'unread','--share-report':'shareReport'}[flag];
 if(!property)return false;o[property]=true;return true;
}
function validateShared(o){
 if(o.returnBudget!==undefined&&(!o.syncOnly||['post-comments','user-posts'].includes(o.mode)))throw Error('--return-budget 仅用于 --sync-only 的用户互动及 @ 数据更新');
 if(o.syncOperation&&['post-comments','user-posts'].includes(o.mode))throw Error('--sync-operation 仅用于 --sync-only 的用户互动及 @ 数据更新');
 if(o.syncOperation&&!o.syncOnly)throw Error('--sync-operation 需要 --sync-only');
 if(o.syncOnly&&o.update&&(o.from||o.to))throw Error('快速检查只检查成功位置之后的新增；日期范围请使用常规更新');
 if(o.unread&&(!o.database||!['sent','received','both'].includes(o.mode)))throw Error('--unread 仅用于本地互动报告');
 if(o.syncOnly&&o.database)throw Error('--sync-only 与 --database 分别用于更新资料库和生成报告，不可同时使用');
 if(o.batch&&!o.database||o.newOnly&&!o.batch)throw Error('--batch 仅用于 --database；--new-only 需指定更新批次');
 if(o.syncOnly&&o.mode!=='user-posts'&&(o.from||o.to)){
  if(o.mode==='post-comments')throw Error('单条微博评论暂不支持日期范围更新');
  const range=dates.bounds(o.from||'',o.to||'');o.startMs=range.startMs;o.beforeMs=Number.isFinite(range.endMs)?range.endMs:null;
 }

 if(o.database){if(o.update||o.refresh||hasBefore(o)||o.downloadImages||o.fullText)throw Error('--database 是本地日期范围导出，不可与 --update、--refresh、--before、图片下载或全文补取同用');Object.assign(o,dates.bounds(o.from||'',o.to||''));o.offline=true;}else if(!o.syncOnly&&o.mode!=='user-posts'&&(o.from||o.to))throw Error('--from / --to 在互动查询中需配合 --database');
 if(o.offline&&o.refresh)throw Error('--offline 与 --refresh 不可同时使用');
 if(o.update&&(o.offline||o.refresh||hasBefore(o)||o.historyRecovery===false))throw Error('--update 用于在线增量更新，不可与 --offline、--refresh、--before 或 --no-history-recovery 同用');
}
function options(args){
 const [target,inputMode]=args;
 if(!Object.hasOwn(COMMANDS,inputMode))throw Error(`不支持的命令 ${inputMode||'（未提供）'}；请用 --help 查看可用命令`);
 const mode=COMMANDS[inputMode],postMode=mode==='post-comments';
 if(mode==='user-posts')return postsOptions(args);
 if(!postMode&&!/^\d{5,20}$/.test(target||''))throw Error('缺少有效 UID 或模式');
 const o={uid:postMode?'':target,mode,command:commandName(mode),shareReport:true,count:postMode?Infinity:50,pages:Infinity,seekLimit:80,pageSize:200,offline:false,refresh:false,dryRun:false,beforeMs:null,historyRecovery:true};
 const countState={};
 if(postMode)o.postId=parsePostTarget(target);
 for(let i=2;i<args.length;i++){
   const a=args[i];
   if(a==='--sync-operation'){const v=args[++i];if(!['regular','quick'].includes(v))throw Error('--sync-operation 仅支持 regular / quick');o.syncOperation=v;if(v==='quick')o.update=true;}
   else if(a==='--return-budget'){o.returnBudget=readLimit(args[++i],a);}
   else if(a==='--empty-window-limit'){o.emptyWindowLimit=readLimit(args[++i],a);}
   else if(a==='--all')assignCount(o,'all',a,countState);
   else if(['--count','--limit','--pages','--page-size','--seek-limit'].includes(a)){
     if(i+1>=args.length||args[i+1].startsWith('--'))throw Error(`${a} 缺少值`);
     const value=args[++i];
     if(a==='--count'||a==='--limit')assignCount(o,value,a,countState);
     else if(a==='--pages')o.pages=readLimit(value,a);
     else if(a==='--seek-limit'){if(postMode)throw Error('--seek-limit 仅用于带 --before 的用户查询');o.seekLimit=readLimit(value,a);}
     else o.pageSize=readPageSize(value,a,200);
   }else if(a==='--from'||a==='--to'){if(!args[i+1]||args[i+1].startsWith('--'))throw Error(a+' 缺少日期');const value=args[++i];parseBefore(value);o[a.slice(2)]=value;
   }else if(a==='--batch'){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('--batch 缺少更新批次');o.batch=args[++i];
   }else if(a==='--before'){
     if(i+1>=args.length||args[i+1].startsWith('--'))throw Error('--before 缺少日期，只需 YYYY-MM-DD');
     o.beforeMs=parseBefore(args[++i]);
   }else if(a==='--update'){if(postMode)throw Error('--update 仅用于用户互动及 @ 查询');o.update=true;}
   else if(a==='--no-history-recovery'){if(postMode)throw Error('--no-history-recovery 仅用于用户互动及 @ 查询');o.historyRecovery=false;}
   else if(sharedOption(o,a))continue;
   else if(a==='--split')throw Error('不支持 --split：comments-and-mentions 的三种查询各自使用独立 --count 上限');
   else throw Error(`不支持的参数 ${a}`);
 }
 if(args.includes('--seek-limit')&&!hasBefore(o)&&!(o.syncOnly&&(o.from||o.to)))throw Error('--seek-limit 仅在指定 --before 时使用');
 if(postMode&&hasBefore(o))throw Error('--before 目前用于用户互动及 @ 查询，不适用于 post-comments');
 if(o.database&&countState.count==null)o.count=Infinity;
 validateShared(o);
 return o;
}
function postsOptions(args){
 const [uid]=args;if(!/^\d{5,20}$/.test(uid||''))throw Error('缺少有效账户 UID');
 const o={uid,mode:'user-posts',from:'',to:'',shareReport:true,count:Infinity,pages:Infinity,pageSize:100,offline:false,refresh:false,dryRun:false,downloadImages:false,fullText:false,emptyWindowLimit:20};
 const countState={};
 for(let i=2;i<args.length;i++){
  const flag=args[i];
  if(flag==='--all')assignCount(o,'all',flag,countState);
  else if(['--from','--to','--count','--limit','--pages','--page-size','--empty-window-limit'].includes(flag)){
   if(!args[i+1]||args[i+1].startsWith('--'))throw Error(flag+' 缺少值');const value=args[++i];
   if(flag==='--from'||flag==='--to'){try{parseBefore(value);}catch{throw Error(flag+' 日期无效，只需 YYYY-MM-DD');}o[flag.slice(2)]=value;}
   else if(flag==='--count'||flag==='--limit')assignCount(o,value,flag,countState);
   else if(flag==='--pages')o.pages=readLimit(value,flag);
   else if(flag==='--empty-window-limit')o.emptyWindowLimit=readLimit(value,flag);
   else o.pageSize=readPageSize(value,flag,100);
  }else if(flag==='--batch'){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('--batch 缺少更新批次');o.batch=args[++i];}
  else if(sharedOption(o,flag))continue;
  else if(flag==='--download-images')o.downloadImages=true;
  else if(flag==='--full-text')o.fullText=true;
  else throw Error('user-posts 不支持参数 '+flag);
 }
 if(o.database){validateShared(o);return o;}
 Object.assign(o,dates.bounds(o.from,o.to));
 if(o.pageSize>100)throw Error('user-posts --page-size 范围 1–100');
 validateShared(o);
 // A one-second overlap protects inclusive dates against strict server timestamp comparisons.
 if(o.from)o.startTime=Math.floor(o.startMs/1000)-1;if(o.to)o.endTime=Math.floor((o.endMs+1)/1000);return o;
}
module.exports={options,postsOptions};
