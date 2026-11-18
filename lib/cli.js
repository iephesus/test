'use strict';
const {prepareOutputLayout}=require('./storage');
const {runUserComments}=require('./user-comments');
const {runPostComments}=require('./post-comments');
const {runUserPosts}=require('./user-posts');
const {options:parseOptions}=require('./options');
function help(){console.log(`Weibo Reader · 微博 HTML 工具

用法：
  node weibo_cli.js <UID> <模式> [选项]
  node weibo_cli.js <微博ID或链接> post-comments [选项]

模式：
  user-posts              按日期范围导出账户微博（--from 日期 --to 日期）
  post-comments           单条微博的评论，默认自动分页读取可见记录（保留返回的楼中楼）
  comments-sent           发出的评论
  comments-received       收到的评论
  comments-both           发出和收到的评论
  mentions-in-comments    被@的评论
  mentions-in-posts       被@的微博
  comments-and-mentions   一次生成：双向评论、被@的评论、被@的微博（一份 HTML；双向查询发出/收到各自接口）

选项：
  --limit N|all   总条数目标，--count 是等价别名；例如 --limit 500000
                  用户查询默认 50，双向各半；post-comments / user-posts 默认不限
  --all           不限总条数，自动读到接口可见末尾；等同于 --limit all
  --pages N|all   可选：每个接口新增 API 次数上限；默认不限，缓存不占额度
                  历史包括定位，user-posts 包括日期核对及可选全文补取
  --seek-limit N|all  历史日期定位的单条探测次数，默认 80；all 不限
  --empty-window-limit N|all  user-posts 连续空窗口次数，默认 20；all 不限
  --page-size N   每次最多请求 N 条（评论默认 / 最大 200；user-posts 默认 / 最大 100）
  --sync-only     只更新数据，不生成 HTML；默认常规更新，完整本地正文计入目标
  --sync-operation regular|quick  用户互动 / @ 的 --sync-only 常规更新 / 快速检查（快捷方式 --update）
                  快速检查只获取成功位置之后的新增；无可靠起点自动首次常规读取
  --return-budget N|all  用户互动 / @ 的 --sync-only 每方向新增返回预算，默认该方向覆盖额度；定位、重复也计入
                  常规覆盖条数与真实返回预算独立，达限保留续取位置
  --batch ID      --database 使用某次更新批次；--new-only 只导出该批次新增的独立记录
  --database      从本地已保存记录生成，不联网，新增 0 credits；日期范围可选
  --from 日期     user-posts / 本地导出的起始日期（包含当天）
  --to 日期       user-posts / 本地导出的结束日期（包含当天）
  --download-images  user-posts 可选：下载图片到本地，不增加 CLI credits
  --full-text     user-posts 可选：为截断正文补取详情，可能额外计费
  --before 日期   从所选当天结束往前取记录，只需 YYYY-MM-DD
                  优先用缓存定位，必要时每次仅探测 1 条；核实边界后正常读取
                  --count 按截止前去重条数计；定位失败不生成空 HTML
  --offline       只读取本地缓存
  --update        用户互动 / @ 增量更新：只取检查点之后的新区间，报告合并本地记录
                  首次无基线时按 --limit 建立基线；中断保留位置，下次继续
                  --limit 同时限制本次新返回量与报告条数（双向各半）；重复 / 核对记录也占额度
                  达限保存位置，下次继续；--all 才取完全部新增，--pages 另限请求次数
  --refresh       重新获取接口数据；旧响应先保存快照，历史补全仍启用
  --no-history-recovery  用户查询仅展示本次读取的独立记录，仍分析已知缺口
  --open          生成成功后自动用系统默认浏览器打开；默认提供报告和文件夹入口
  --verbose       显示逐页请求、游标、完整性诊断和采集记录路径
  --dry-run       显示请求计划，不请求 API
  -h, --help      显示帮助

示例：
  node weibo_cli.js 1234567890 user-posts --from 2025-05-01 --to 2025-06-01
  node weibo_cli.js 9007199254740993 post-comments
  node weibo_cli.js "https://weibo.com/detail/9007199254740993" post-comments --limit 100
  node weibo_cli.js 1234567890 comments-both --sync-only --update --limit 300
  node weibo_cli.js 1234567890 comments-both --sync-only --from 2026-07-01 --to 2026-07-10 --all
  node weibo_cli.js 1234567890 comments-both --database --limit 50
  node weibo_cli.js 1234567890 comments-both --all
  node weibo_cli.js 1234567890 comments-and-mentions --all
  node weibo_cli.js 1234567890 comments-both --limit 500000
  node weibo_cli.js 1234567890 comments-sent --count 100 --pages 2
  node weibo_cli.js 1234567890 comments-both --before 2026-10-25 --count 100
  node weibo_cli.js 1234567890 comments-and-mentions --offline

用户评论：output/user-comments/<账号昵称>/<昵称>_<内容>_<去重数量>条.html
单条微博评论：output/post-comments/<原作者昵称>_<微博ID>/<微博ID>_微博下的评论_<去重数量>条.html
账户微博：output/posts/<账号昵称>/<昵称>_微博_<起始日期>-<结束日期>_<数量>条.html
原微博链接：https://www.weibo.com/detail/原微博ID
用户主页：https://weibo.cn/u/用户UID
全部 / 大批量查询可能持续调用付费接口，按返回内容计费；Ctrl+C 可停止，已保存的分页缓存保留。
comments-and-mentions 选择全部分类；--all 参数表示不限条数。接口不可见或已删除内容无法保证取得。
HTML：互动 / 被@排行榜，折叠对话默认按分支，可改用时间顺序，也可切换到时间线。
`);}
function options(args){
 if(args.includes('--help')||args.includes('-h')){help();process.exit(0);}
 return parseOptions(args);
}
async function main(){
 const o=options(process.argv.slice(2));if(/^[a-f0-9-]{36}$/.test(process.env.WEIBO_DATA_SCOPE||''))o.taskScopeId=process.env.WEIBO_DATA_SCOPE;
 if(!o.taskScopeId&&o.syncOnly&&!o.from&&!o.to&&!Number.isFinite(o.beforeMs))o.taskScopeId=require('node:crypto').randomUUID();
 if(o.taskScopeId&&/^[a-f0-9-]{36}$/.test(process.env.WEIBO_RESUME_SCOPE||'')){
  o.resumeScope=true;
  if(process.env.WEIBO_GAP_BUDGET){
   const {limit,kinds}=JSON.parse(process.env.WEIBO_GAP_BUDGET);
   if(!o.syncOnly||!Number.isSafeInteger(limit)||limit<1||!Array.isArray(kinds)||!kinds.length||
     new Set(kinds).size!==kinds.length||kinds.some(kind=>!['sent','received'].includes(kind)))throw Error('补齐返回上限或方向无效');
   o.gapBudget={limit,kinds};
  }
 }
 require('./events').emit('target',{uid:o.uid||'',mode:o.mode,postId:o.postId||'',limit:Number.isFinite(o.count)?o.count:null,preview:!!o.dryRun});
 const base=require('./config').BASE;if(!o.dryRun)require('./storage').validateLegacyControl(base);if(!o.dryRun)await require('./data-exchange').recover(base);const release=o.dryRun?()=>{}:require('./workspace-access').enter(base);let releaseObject=()=>{};try{
 if(!o.dryRun&&require('./data-exchange').pending(base))throw Error('有待恢复的数据合并，请重新运行命令或在应用中完成恢复后重试');
 if(!o.dryRun&&!o.database)releaseObject=require('./workspace-access').enterObject(base,o.postId?'post':'user',o.postId||o.uid);
 if(!o.dryRun){const migration=prepareOutputLayout();if(migration.conflicts.length)console.error(`迁移时保留了 ${migration.conflicts.length} 份同名但内容不同的历史文件，文件名带 _legacy_ 标记。`);}
 if(o.database)return await require('./local-database').runDatabase(o);
 if(o.mode==='post-comments')return await runPostComments(o);
 if(o.mode==='user-posts')return await runUserPosts(o);
 return await runUserComments(o);
 }finally{try{if(!o.dryRun&&!o.syncOnly&&!o.database){const catalog=require('./report-catalog'),reports=catalog.written(base);if(reports.length){catalog.defer(base,reports);try{if(catalog.maintainPending(base).deferred)console.error('报告已保存；旧报告正在等待打开回执或其他进程，之后自动整理。');}catch(error){console.error('报告已保存；旧报告等待安全清理：'+error.message);}}}}catch(error){console.error('报告维护未完成，原文件保留：'+error.message);}finally{try{releaseObject();}finally{release();}}}
}

async function runMain(){try{return await main();}catch(error){console.error('\n错误：'+require('./terminal-report').conciseError(error,{verbose:process.argv.includes('--verbose')}));process.exitCode=1;}}
module.exports={help,options,main,runMain};
