"use strict";
// Recovery is independent of the selected form and active task. Never clear
// journals or resume a subscription as a side effect of hiding this notice.
window.ReaderRecovery=(()=>{
 let current=null,requestId=null,workspace='';
 const $=id=>document.getElementById(id);
 function render(){
  const box=$('recovery-notice');if(!box)return;
  const items=current?.issues||[];box.hidden=!items.length;if(!items.length)return;
  $('recovery-copy').textContent=current.blocked?'上次任务的部分收尾仍待恢复。已保存数据保留，本地查看与导出可用；相关取数和自动检查暂缓。':'上次任务已保存，部分本地整理仍待恢复。';
  const list=$('recovery-issues');list.replaceChildren();
  for(const item of items){const li=document.createElement('li');li.textContent=(item.target?(item.targetKind==='post'?'博文 ':'用户 ')+item.target+' · ':'')+item.file+' · '+item.failures.map(f=>f.stage+'：'+f.message).join('；');list.append(li);}
  const retry=$('recovery-retry');retry.disabled=!!requestId;retry.textContent=requestId?'正在本地恢复…':'重试本地恢复';
  window.ReaderNotices?.decorate(box,{scope:workspace+'|recovery',key:JSON.stringify(items)});
 }
 $('recovery-retry')?.addEventListener('click',()=>{if(requestId)return;requestId=crypto.randomUUID();render();send({action:'recoveryRetry',requestId});});
 $('recovery-copy-diagnostic')?.addEventListener('click',()=>{if(current)send({action:'copy',text:JSON.stringify({version:document.getElementById('app-version')?.textContent,...current},null,2)});});
 return {receive(event){
  if(event.type==='library'){if(workspace!==event.workspace){workspace=event.workspace;current=null;requestId=null;$('recovery-notice').hidden=true;}return false;}
  if(event.type==='recoveryState'){workspace=event.workspace;current=event;requestId=null;render();return true;}
  if(event.type==='error'&&requestId&&event.requestId===requestId){requestId=null;render();return false;}
  return event.type==='recoveryDiagnostic';
 }};
})();
