"use strict";
// Report configuration, local counts, export and browser opening have one owner.
// Definitions load before app.js; DOM binding happens after its shared state exists.
let localTimer=null;
function reportConditionKey(){
 const q=query(),target=currentTarget();
 const data=state.database.filter(e=>(q.mode==='post-comments'?e.category==='post-comments':e.category!=='post-comments')&&(e.target===target||e.uid===target)).map(e=>[e.category,e.mode,e.updatedAt,e.batchId]);
 return ReaderDataQuery.key(q)+'|'+JSON.stringify(data);
}
function scheduleLocal(){
 clearTimeout(localTimer);if(state.engineAvailable===false)return;
 const key=reportConditionKey();
 if(key!==state.localConditionKey){
  state.localConditionKey=key;state.localRequest=null;state.localResult=null;
  window.ReaderNotices?.reset($('local-counts'));$('local-counts').hidden=false;$('local-counts').textContent='正在统计本地数据…';$('local-time-range').textContent='';
 }
 if(!state.localGenerating)localTimer=setTimeout(requestLocal,250);
}
function requestLocal(){
 clearTimeout(localTimer);
 if(state.engineAvailable===false||state.task!=='report'||state.view!=='create')return;
 const input=query(),error=ReaderUX.validate(input);
 if(error){state.localRequest=null;state.localResult=null;window.ReaderNotices?.reset($('local-counts'));$('local-counts').hidden=false;$('local-counts').textContent=error.message;window.ReaderNotices?.decorate($('local-counts'),{key:'validation'});return;}
 const requestId=String((state.localSequence||0)+1);state.localSequence=Number(requestId);state.localRequest=requestId;
 $('form-error').hidden=true;window.ReaderNotices?.reset($('local-counts'));$('local-counts').hidden=false;$('local-counts').textContent='正在统计本地数据…';
 send({action:'localData',requestId,query:input,summaryOnly:true});
}
function handleLocal(event){
 if(event.requestId!==state.localRequest||state.task!=='report'||ReaderDataQuery.key(event.query)!==ReaderDataQuery.key(query()))return;
 state.localResult=event;
 const n=event.summary,q=event.query,comments=q.mode==='post-comments',posts=q.mode==='user-posts';
 const format=ReaderDates.displayDay;
 const counts=$('local-counts');
 window.ReaderNotices?.reset(counts);counts.hidden=false;counts.textContent=(n.peerUid?'与 '+(n.peerName||n.peerUid)+' 的互动 · ':'')+'符合条件 '+numeric(n.matched)+' 条，本次报告'+(q.unlimited?'全部 ':'最新 ')+numeric(n.selected)+' 条'+(comments?'评论':posts?'微博':'');
 if(!comments&&!posts)counts.append(' · ',markCommentDirection(node('span','','发出 '+numeric(n.sent)+' 条'),'sent'),' · ',markCommentDirection(node('span','','收到 '+numeric(n.received)+' 条'),'received'));
 $('local-time-range').textContent=(n.oldest!=null?'实际时间范围：'+format(n.oldest)+' — '+format(n.newest):'暂无匹配的本地数据')+(q.markUnread?' · 本报告未读 '+numeric(n.unread)+' 条 / '+(q.mode==='post-comments'?'该博文':'该用户')+'总未读 '+numeric(n.totalUnread)+' 条':'');
 $('local-scope-note').textContent='引用上下文不计条数；本地已保存内容不代表完整历史。'+(n.missingBodyCount?'另有 '+n.missingBodyCount+' 个已知 ID 缺失正文，需补充时请获取数据。':'')+(n.warnings?.length?'有 '+n.warnings.length+' 项读取提示，详情见获取历史。':'');
 $('local-results').hidden=false;
}
function exportUnreadUser(uid){
 if(!ReaderUX.uid(uid))return;
 exportLocal({target:uid,subject:{kind:'user',uid},mode:'comments-both',task:'report',policy:'database',unlimited:true,markUnread:true,unreadOnly:true,unreadContext:true});
}
function exportLocal(capturedQuery){
 if(state.engineAvailable===false){toast('运行引擎已停止，请重新打开应用后生成；已有数据保留。',true);return;}
 if(state.localGenerating){toast('报告正在生成，请稍候。');return;}
 clearTimeout(localTimer);
 const input=capturedQuery||query(),error=ReaderUX.validate(input);
 if(error){toast(error.message,true);$('form-error').textContent=error.message;$('form-error').hidden=false;window.ReaderNotices?.decorate($('form-error'),{key:'validation:'+crypto.randomUUID()});$(error.field)?.focus();return;}
 if(input.policy!=='database'){toast('请先选择导出数据。');return;}
 const requestId=String((state.localSequence||0)+1);state.localSequence=Number(requestId);state.localRequest=requestId;
 const token=state.localResult&&ReaderDataQuery.key(state.localResult.query)===ReaderDataQuery.key(input)?state.localResult.token:undefined;
 state.browserReport=null;state.localGenerating={requestId,query:input,workspace:state.workspace};renderReportFolderAction();if(!state.busy&&!capturedQuery){state.cardFormKey=ReaderDataQuery.key(input);status('生成中','running');setProgress('正在生成本地报告',null,'0 credits');}if(!capturedQuery){$('form-error').hidden=true;$('start').disabled=true;$('start').textContent='正在生成报告…';}
 send({action:'localExport',requestId,query:input,token,openWhenReady:true});
}
function handleReportEvent(event){
 if(event.type==='reportsUpdated'){
  if(Array.isArray(event.owners)){
   const owners=new Set(event.owners),changed=new Set(event.reports.map(report=>report.id));
   const key=report=>report.ownerKey||(report.category==='post-comments'?'post:'+report.postId:'user:'+report.uid);
   state.reports=[...state.reports.filter(report=>!owners.has(key(report))&&!changed.has(report.id)),...event.reports].sort((a,b)=>b.modified-a.modified);
  }else state.reports=event.reports;
  window.renderContextReports?.();return true;
 }
 if(event.type==='engineStopped'||event.type==='engineTransportError'){
  state.engineAvailable=false;clearTimeout(localTimer);state.localRequest=null;state.localResult=null;
  if(state.localGenerating){state.localGenerating=null;updateForm();syncProgressMotion();status('生成已中断','warning');setProgress(event.type==='engineTransportError'?'引擎通信异常':'运行引擎已停止',null,'0 credits');window.ReaderNotices?.reset($('local-counts'));$('local-counts').hidden=false;$('local-counts').textContent='本地处理已中断；已有数据和报告保留。';window.ReaderNotices?.reset($('progress-message'));$('progress-message').hidden=false;$('progress-message').textContent='请重新打开应用后重试，本地生成不会重新获取付费内容。';window.ReaderNotices?.decorate($('progress-message'),{key:event.type});}
  return false;
 }
 if(event.type==='browserOpenFailed'){
  if(state.browserReport?.id===event.id&&!state.busy&&taskMatchesForm(state.browserReport.query)){status('报告已保存，打开失败','warning');window.ReaderNotices?.reset($('progress-message'));$('progress-message').hidden=false;$('progress-message').textContent=event.message||'浏览器未能打开，请从已生成报告重试。';}
  if(state.browserReport?.id===event.id&&!state.busy&&taskMatchesForm(state.browserReport.query))window.ReaderNotices?.decorate($('progress-message'),{key:event.id+':open-failed'});toast(event.message||'报告已保存，浏览器打开失败；未修改已读状态。',true);return true;
 }
 if(event.type==='localData'){handleLocal(event);return true;}
 if(event.type==='foregroundDequeued'&&event.action==='localExport'&&event.cancelled){
  const generation=state.localGenerating;
  if(!generation||event.requestId!==generation.requestId||event.workspace!==generation.workspace)return true;
  const ownsCard=!state.busy&&taskMatchesForm(generation.query);state.localGenerating=null;if(state.localRequest===event.requestId)state.localRequest=null;updateForm();syncProgressMotion();renderReportFolderAction();
  if(ownsCard){status('已取消生成','warning');setProgress('本次报告生成已取消',null,'0 credits');window.ReaderNotices?.reset($('progress-message'));$('progress-message').hidden=false;$('progress-message').textContent='本次生成已取消，已有数据和报告保留。';}else toast('已取消排队中的报告生成。');
  return true;
 }
 if(event.type==='localExported'){
  if(event.requestId!==state.localGenerating?.requestId)return true;
  const generation=state.localGenerating,ownsCard=!state.busy&&taskMatchesForm(generation.query);state.localGenerating=null;state.currentReports=event.files||[];updateForm();syncProgressMotion();
  if(event.files?.[0]){
   state.browserReport={id:event.files[0],query:generation.query,workspace:generation.workspace};
   renderReportFolderAction();
   if(ownsCard){status(event.reused?'报告已就绪':'报告已生成','success');setProgress('报告已就绪',1,'100%');window.ReaderNotices?.reset($('progress-message'));$('progress-message').hidden=false;$('progress-message').textContent='正在交给默认浏览器打开…';}
   toast(event.reused?'复用已有报告':'已生成 '+numeric(event.summary.selected)+' 条，新增费用 0 credits');
   if(!event.openDispatched)openReport(event.files[0]);
  }else{if(ownsCard){status('无匹配数据');setProgress('本地范围内没有匹配记录',0,'0 条');}toast(generation.query.unreadOnly?'当前没有可打开的未读评论。':'没有符合条件的本地数据，请调整日期或先获取数据。');}
  return true;
 }
 if(event.type==='localError'){
  const generation=event.requestId===state.localGenerating?.requestId,owner=generation?state.localGenerating.query:null;
  if(!generation&&event.requestId&&event.requestId!==state.localRequest)return true;
  if(generation){state.localGenerating=null;updateForm();syncProgressMotion();if(!taskMatchesForm(owner)){toast(event.message,true);return true;}status('报告未生成','warning');setProgress('本地生成未完成',null,'0 credits');window.ReaderNotices?.reset($('progress-message'));$('progress-message').hidden=false;$('progress-message').textContent=event.message+'；已有数据和报告保留。';window.ReaderNotices?.decorate($('progress-message'),{key:event.requestId});}
  if(/数据或查看条件已变化/.test(event.message)){state.localResult=null;requestLocal();toast('本地数据已变化，已刷新数量；请核对后重新生成。');}
  else{window.ReaderNotices?.reset($('local-counts'));$('local-counts').hidden=false;$('local-counts').textContent=event.message;window.ReaderNotices?.decorate($('local-counts'),{key:event.requestId||'local-error'});toast(event.message,true);}
  return true;
 }
 if(event.type==='browserOpened'){if(!state.busy&&state.browserReport?.id===event.id&&taskMatchesForm(state.browserReport.query)){window.ReaderNotices?.reset($('progress-message'));$('progress-message').hidden=false;$('progress-message').textContent='报告已在默认浏览器打开。';}return true;}
 if(event.type==='reportMarkedRead'){
  const matching=event.targetKind==='post'?state.selection?.kind==='post'&&!!event.postId&&currentTarget()===event.postId:!!event.uid&&ReaderIdentity.user(state)===event.uid;
  if(state.task==='report'&&state.view==='create'&&matching&&event.readingChanged!==false){state.localResult=null;state.localRequest=null;scheduleLocal();}
  toast(event.changed?'报告已打开，其中 '+numeric(event.changed)+' 条已标为已读，仍有 '+numeric(event.unread)+' 条未读。':'报告已打开，未读状态已同步。');
  if(!state.busy&&state.browserReport&&state.browserReport.id===event.id&&taskMatchesForm(state.browserReport.query)){window.ReaderNotices?.reset($('progress-message'));$('progress-message').hidden=false;$('progress-message').textContent='报告已在默认浏览器打开。';}return true;
 }
 return false;
}
function openReport(id,kind='report'){send({action:'open',id,kind});}
function readReport(id){openReport(id);}

// The shortcut belongs to the saved report, never to the next form's target.
function reportFolderTarget(){
 const report=state.browserReport;
 return report&&report.workspace===state.workspace&&state.task==='report'&&!state.localGenerating&&taskMatchesForm(report.query)?report:null;
}
function renderReportFolderAction(){
 const control=$('report-folder');
 control.hidden=!reportFolderTarget();
 control.onclick=()=>{const report=reportFolderTarget();if(report)openReport(report.id,'folder');};
}
