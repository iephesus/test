'use strict';
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawnSync}=require('node:child_process');

// Terminal content can include remote nicknames and server errors.
const terminalText=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,' ').trim();
const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
function conciseError(error,options={}){
 const raw=String(error?.message??error??'');if(options.verbose)return raw;
 const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
 if(start>=0&&end>start){try{const parsed=JSON.parse(raw.slice(start,end+1)),e=parsed.error||parsed.data?.error;if(e)return terminalText([e.code,e.message].filter(Boolean).join('：'));}catch{}}
 const code=raw.match(/"code"\s*:\s*"([^"]+)"/)?.[1],message=raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
 if(code&&message)return terminalText(code+'：'+message);
 return terminalText(raw).slice(0,360);
}
function createProgress(options={},dependencies={}){
 const stream=dependencies.stream||process.stdout,log=dependencies.log||(value=>console.log(value)),now=dependencies.now||Date.now;
 const env=dependencies.env||process.env,tty=!!stream.isTTY&&env.TERM!=='dumb'&&!env.CI;
 let last=now(),active=false;
 function end(){if(active){stream.write('\r\u001b[2K');active=false;}}
 function detail(message){if(options.verbose){end();log(message);}}
 function note(message){end();log(message);}
 function update(summary,details=summary){
  require('./events').emit('progress',{message:terminalText(summary)});
  if(options.verbose){detail(details+(options.creditMeter?' | '+options.creditMeter.progress():''));return;}
  const message=terminalText(summary);
  if(tty){const limit=Math.max(10,(stream.columns||100)-2);let width=0,shown='';for(const char of message){const size=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303f\uff01-\uff60]/u.test(char)?2:1;if(width+size>limit)break;shown+=char;width+=size;}stream.write('\r\u001b[2K'+shown);active=true;}
  else if(now()-last>=15000){log('  '+message);last=now();}
 }
 return {update,detail,note,end};
}
function requestPolicy(o){
 const data=o.offline?'离线缓存，不新增 API':o.update?'增量取新，历史复用本地':o.refresh?'刷新接口数据，保留旧快照':'缓存优先';
 const cap=Number.isFinite(o.pages)?`每接口最多新增 API ${o.pages} 次`:'新增 API 次数不限';
 return `${data} · ${o.offline?'不消耗 API credits':cap}`;
}
function sourceSummary(source,label,options={}){
 const count=source.rows.length,budget=Number.isFinite(source.budget)?source.budget:'不限',c=source.completeness;
 const extras=[];if(c?.recovered)extras.push(`历史补全 ${c.recovered} 条`);
 if(c?.knownIds)extras.push(`已知 ID ${c.readable}/${c.knownIds}`);
 if(c?.missingKnownIds)extras.push(`仍缺正文 ${c.missingKnownIds} 条`);
 if(c?.unidentifiedMissing)extras.push('另有无法对应 ID 的缺口');
 if(c?.archiveWarnings)extras.push(`异常旧缓存 ${c.archiveWarnings} 份，原文件保留`);
 if(source.update){const u=source.update;extras.push(u.initialized?'首次建立更新基线':`新增 ${u.newCount} 条，本地复用 ${u.reusedCount} 条`);extras.push(`本次新返回 ${u.newReturned??source.newFetched} / ${u.returnLimit??'不限'} 条`);if(u.limited)extras.push('已达取数上限，可继续更新');if(u.resumed)extras.push('续取上次更新');if(u.restartReason)extras.push('旧续取响应不可用，已从原检查点重新核对');if(!u.caughtUp)extras.push('新增区间未读完，检查点未推进');if(u.sinceIgnored)extras.push('接口忽略 since_id，已按 max_id 核对');}
 const gap=source.update?.gap;if(gap&&(gap.unresolvedIds.length||gap.unidentifiedMissing))extras.push(`增量区间仍缺 ${gap.unresolvedIds.length} 个已知 ID${gap.unidentifiedMissing?'，另有未定位缺失':''}`);
 const lines=[`  ${label}：${count} / ${budget} 条${extras.length?' · '+extras.join(' · '):''}`];
 const {sourceIncomplete}=require('./limits');
 if(sourceIncomplete(source)||source.ended||options.verbose)lines.push('    '+conciseError(source.reason,options));
lines.push(...require('./record-availability').availabilityLines(source.availability,{verbose:!!options.verbose}).map(line=>'    '+line));
 return lines;
}
function reportAction(file,platform=process.platform,targetType='report',browser=''){
 const absolute=path.resolve(file),url=pathToFileURL(absolute).href;
 if(platform==='darwin'){const app=targetType==='folder'?'Finder':browser,args=app?['-a',app,absolute]:[absolute];return {command:'open',args,display:(app?'open -a '+(app==='Finder'?'Finder':shellQuote(app))+' ':'open ')+shellQuote(absolute),url};}
 if(platform==='win32')return {command:'rundll32.exe',args:['url.dll,FileProtocolHandler',url],display:'rundll32.exe url.dll,FileProtocolHandler "'+url+'"',url};
 return {command:'xdg-open',args:[absolute],display:'xdg-open '+shellQuote(absolute),url};
}
function reportShortcutLines(file,{isTTY=!!process.stdout.isTTY,env=process.env,platform=process.platform,verbose=false,systemLinks=null}={}){
 const report=reportAction(file,platform),folder=reportAction(path.dirname(path.resolve(file)),platform,'folder');
 const supported=isTTY&&env.TERM!=='dumb'&&!env.CI&&env.TERM_PROGRAM!=='Apple_Terminal';
 const link=(action,label)=>'\u001b]8;;'+action.url+'\u001b\\['+label+' ↗]\u001b]8;;\u001b\\';
 const vscode=platform==='darwin'&&(env.TERM_PROGRAM==='vscode'||env.VSCODE_PID);
 const fallback=['  打开报告：'+report.display,'  所在文件夹：'+folder.display];
 const lines=supported&&vscode&&systemLinks?['  打开：'+link({url:systemLinks.report},'报告')+'  '+link({url:systemLinks.folder},'所在文件夹'),...(verbose?fallback:[])]:supported&&!vscode?['  打开：'+link(report,'报告')+'  '+link(folder,'所在文件夹')]:fallback;
 if(verbose)lines.push('  报告地址：'+report.url,'  文件夹地址：'+folder.url);
 return lines;
}
function reportShortcut(file,options={},dependencies={}){
 const log=dependencies.log||console.log,warn=dependencies.warn||console.error;
 let prepared=require('./report-catalog').takePrepared(file);try{
 if(require('./events').enabled()){require('./events').emit('report',{file:path.resolve(file),...(prepared?{preparedToken:prepared.token}:{})});prepared=null;return;}
 const env=dependencies.env||process.env,platform=dependencies.platform||process.platform,isTTY=dependencies.isTTY??!!process.stdout.isTTY;let systemLinks=null;
 if(!options.dryRun&&platform==='darwin'&&isTTY&&!env.CI&&env.TERM!=='dumb'&&(env.TERM_PROGRAM==='vscode'||env.VSCODE_PID)){
  try{systemLinks=(dependencies.getSystemLinks||require('./system-open').getSystemLinks)(file);}catch(error){warn('  系统打开入口暂不可用，请使用下面的备用命令。');}
 }
 for(const line of reportShortcutLines(file,{verbose:options.verbose,...dependencies,systemLinks}))log(line);
 if(!options.openReport||options.dryRun)return;
 if(!fs.existsSync(file)){warn('  自动打开失败：报告文件不存在；未重新查询数据。');return;}
 let browser='';if(platform==='darwin'&&!systemLinks){try{browser=(dependencies.resolveBrowser||require('./system-open').defaultBrowser)();}catch{warn('  报告已保存，无法确定系统默认浏览器；请手动选择浏览器打开。');return;}}
 const action=systemLinks?{command:'/usr/bin/open',args:[systemLinks.view]}:reportAction(file,platform,'report',browser),spawn=dependencies.spawn||spawnSync;
 let result;try{result=spawn(action.command,action.args,{encoding:'utf8',timeout:10000,shell:false,stdio:'ignore'});}catch(error){result={error};}
 if(result?.error||result?.status!==0)warn('  报告已保存，自动打开失败；请使用上面的打开入口。');
 else log('  已使用浏览器打开报告。');
 }finally{if(prepared)try{const result=prepared.release();if(result?.deferred)warn('  报告已保存；旧报告保护将在其他进程完成后自动释放。');}catch(error){warn('  报告已保存；保护记录未能释放，原记录保留：'+conciseError(error,options));}}
}
module.exports={terminalText,conciseError,createProgress,requestPolicy,sourceSummary,shellQuote,reportAction,reportShortcutLines,reportShortcut};
