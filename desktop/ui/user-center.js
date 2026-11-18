'use strict';
// The page is a local view of a UID. Running jobs retain their own immutable query.
(()=>{
 let homeFilter='all';state.homeUsers??=[];
 const current=()=>ReaderIdentity.user(state),user=uid=>state.homeUsers.find(u=>u.uid===uid)||state.accounts.find(u=>u.uid===uid)||{uid,nickname:'用户 '+uid};
 function avatar(u){return window.userAvatar?window.userAvatar(u):node('span','user-avatar',u.nickname?.slice(0,1)||'微');}
 const continuationDismissed=(uid,task)=>task.noticeDismissed===true;
 function pendingLabel(u){
  if(!u.hasPending)return null;const tasks=u.pendingTasks||[];
  if(!tasks.length)return {text:u.pendingMessage||'有未完成读取任务',detail:u.pendingDetail};
  const visible=tasks.filter(t=>!t.historicalContinuation&&(t.status==='running'||!t.resumedBy&&t.progressStatus?.resumable!==false&&!continuationDismissed(u.uid,t)));
  if(!visible.length)return null;
  return {text:visible.length===tasks.length?u.pendingMessage||'有未完成读取任务':visible.some(t=>t.status==='running')?'正在获取数据':'有未完成读取任务',detail:visible.length===tasks.length?u.pendingDetail:''};
 }
 function profileNotice(u){
  if(u.profileNoticeDismissed||u.profileStatus!=='error')return null;
  return {text:u.profileMessage||'资料暂不可用，可在用户页重试',detail:u.profileDetails,source:'cli',key:JSON.stringify(['profile',u.profileNoticeId,u.profileStatus,u.profileMessage]),className:'home-profile-notice'};
 }
 function backgroundNotices(user,pending){
  if(!pending||user.pendingTasks?.length)return [];
  const evidence=user.pendingEvidence||[];
  if(evidence.length)return evidence.map(item=>({
   ...pending,source:item.source,scope:item.kind,
   key:JSON.stringify(['pending-evidence',item.kind,item.taskId,item.token]),className:'home-pending'
  }));
  return [{...pending,source:'unknown',key:JSON.stringify(['legacy-pending',pending.text,pending.detail||'']),className:'home-pending'}];
 }
 ReaderEntityActions.installClearNotices($('user-list-toolbar'),()=>state.homeUsers.flatMap(u=>{
  const tasks=(u.pendingTasks||[]).filter(ReaderEntityActions.canContinue).flatMap(task=>ReaderEntityActions.taskAcknowledgments('user',u.uid,task));
  const profile=profileNotice(u);
  for(const notice of backgroundNotices(u,pendingLabel(u)))tasks.push(ReaderEntityActions.listNoticeOptions('user',u.uid,notice));
  if(profile)tasks.push(ReaderEntityActions.listNoticeOptions('user',u.uid,profile));
  return tasks;
 }));
 function renderHome(){const entries=state.homeUsers.length?state.homeUsers:state.accounts,homeStatus=ReaderEntityActions.homeLoadStatus('users','user-list-state',entries.length>0),term=$('home-search').value.trim().toLowerCase(),list=$('home-users');list.setAttribute('role','list');list.replaceChildren();const rows=entries.filter(u=>(homeFilter!=='favorites'||state.favorites.includes(u.uid))&&(homeFilter!=='unread'||Number(u.unread)>0)&&(!term||[u.nickname,u.uid,u.note,...(u.aliases||[])].join(' ').toLowerCase().includes(term))).sort((a,b)=>(Number(state.favorites.includes(b.uid))-Number(state.favorites.includes(a.uid)))||String(b.lastViewedAt||'').localeCompare(String(a.lastViewedAt||''))||String(a.nickname||a.uid).localeCompare(String(b.nickname||b.uid),'zh-CN'));
  $('home-empty').hidden=rows.length>0||homeStatus!=='ready';$('home-empty').textContent=homeFilter==='unread'?'暂无符合条件的未读用户。':term?'没有匹配的用户。':'添加一个用户，开始管理本地数据。';for(const u of rows){const card=node('article','user-home-card'),heading=node('div','user-home-heading'),open=button('','user-open',()=>openUser(u.uid));card.dataset.targetId=u.uid;ReaderEntityActions.listRow(card,()=>openUser(u.uid));open.title=[ReaderEntityActions.displayName(u,''),u.nickname,'UID '+u.uid].filter(Boolean).join(' · ');open.setAttribute('aria-label','打开用户 '+open.title);const nameSlot=node('span','user-name-slot');nameSlot.append(node('strong','',ReaderEntityActions.displayName(u,u.nickname||'未知昵称')));open.append(avatar(u),nameSlot,node('span','muted','UID '+u.uid));const favorite=state.favorites.includes(u.uid),star=button(favorite?'★':'☆','user-star'+(favorite?' is-favorite':''),()=>toggleFavorite(u.uid));star.setAttribute('aria-label',(favorite?'取消关注 ':'关注 ')+ReaderEntityActions.displayName(u,u.nickname));star.setAttribute('aria-pressed',String(favorite));heading.append(open,star,button('删除','text-button danger-button',()=>window.requestUserDelete?.(u.uid)));card.append(heading);const facts=node('div','home-user-facts');const tasks=u.pendingTasks||[],pending=pendingLabel(u),notices=ReaderEntityActions.taskNotices(tasks.filter(t=>!t.historicalContinuation),pending?.text,pending?.detail);
   const factsPending=!state.homeUsers.length&&homeStatus!=='ready',factsFailed=homeStatus==='error';
   const unread=factsPending?(factsFailed?'未读统计暂不可用':'正在读取未读统计'):u.unreadUnavailable?'未读统计暂不可用':u.unread?u.unread+' 条未读':'暂无未读';
   const status=node('div','home-status'),unreadLabel=!factsPending&&!u.unreadUnavailable&&u.unread
    ?button(unread,'text-button home-unread',()=>exportUnreadUser(u.uid))
    :node('span',u.unreadUnavailable?'home-status-warning':'muted',unread);
   if(unreadLabel.tagName==='BUTTON')unreadLabel.title=unread+' · 生成并打开报告，补充最多 100 条前文';
   status.append(unreadLabel);if(tasks.some(task=>task.status==='running'))status.append(node('span','home-running','获取中'));
   const checkedAt=u.lastCheckAt||u.lastSuccessAt;
   const check=factsPending?(factsFailed?'检查记录暂不可用':'正在读取检查记录'):checkedAt?relativeTime(checkedAt):'暂无检查记录';
   const activity=factsPending?(factsFailed?'互动时间暂不可用':'正在读取互动时间'):u.latestInteractionMs?relativeTime(u.latestInteractionMs):'暂无本地时间';
   facts.append(status,ReaderEntityActions.fact('最近检查',check,checkedAt?dateText(Date.parse(checkedAt)):''),ReaderEntityActions.fact('最近互动',activity,u.latestInteractionMs?dateText(u.latestInteractionMs):''));
   const background=[];
   notices.push(...backgroundNotices(u,pending));
   if(u.profileStatus==='loading')background.push(u.profileMessage||'正在识别用户资料…');
   if(background.some(Boolean))status.title=[status.textContent,...background].filter(Boolean).join(' · ');
   const profile=profileNotice(u);if(profile)notices.push(profile);
   for(const line of facts.children)if(!line.title)line.title=line.textContent;card.append(facts);card.append(ReaderEntityActions.actions('user',u.uid));ReaderEntityActions.noticeSlot(card,'user',u.uid,notices);list.append(card);}
  all('[data-home-filter]').forEach(el=>{const active=el.dataset.homeFilter===homeFilter;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});if(current())renderIdentity();window.renderMultiSelect?.('user');
 }
 function renderIdentity(){const uid=current(),u=user(uid);if($('post-identity'))$('post-identity').hidden=true;const nickname=node('strong','current-user-name',ReaderEntityActions.displayName(u,u.nickname)),uidLabel=node('span','current-user-uid','UID '+uid);nickname.title=u.nickname;$('current-user-identity').replaceChildren(avatar(u),nickname,uidLabel);const actions=$('user-page-actions');actions.querySelector('.entity-identity-actions')?.remove();const links=ReaderEntityActions.actions('user',uid,{note:true});links.classList.add('entity-identity-actions');ReaderEntityActions.renderContinuations('user',uid);if(!u.unreadUnavailable&&u.unread)links.prepend(button('查看未读 · '+numeric(u.unread),'button secondary',()=>exportUnreadUser(uid)));actions.prepend(links);$('user-identity').querySelector('.entity-detail-note')?.remove();$('user-page-title').textContent=ReaderEntityActions.displayName(u,u.nickname);$('user-page-subtitle').textContent='按互动发生时间阅读本地数据；获取与导出由你主动操作。';$('user-page-actions').hidden=!uid;$('user-identity').hidden=!uid;$('user-target-field').hidden=!!uid;$('local-results-title').textContent=state.category==='posts'?'本地微博':'本地互动';$('user-home-back').hidden=false;$('user-home-back').textContent='‹ 返回用户列表';$('user-home-back').setAttribute('aria-label','返回用户列表');$('category-tabs').hidden=false;window.renderUserProfile?.();window.renderContextReports?.();showUserTask();window.renderSubscriptionToggle?.('user',uid);}
 function openUser(uid){if(!/^\d{5,20}$/.test(uid))return;ReaderEntityActions.close();rememberFilters();ReaderIdentity.selectUser(state,uid);state.category='users';$('target').value=uid;$('mode').value='comments-both';state.task='sync';syncUserFilters();closePicker();view('create');updateForm();renderIdentity();send({action:'userViewed',uid,metadata:{nickname:user(uid).nickname}});}
 window.openUser=openUser;selectUser=(uid)=>openUser(uid);
 function openPost(id=''){if(window.openPostPage)return window.openPostPage(id);rememberFilters();state.postParent=current();ReaderIdentity.selectPost(state,id);state.category='post';$('target').value=id;state.task=id?'report':'sync';state.updateOperation='regular';syncUserFilters();view('create');updateForm();$('user-page-actions').hidden=true;$('user-identity').hidden=true;$('user-target-field').hidden=false;$('user-page-title').textContent='微博评论';$('user-page-subtitle').textContent='粘贴微博链接或选择已保存微博；任务按微博 ID 独立保存。';$('user-home-back').hidden=false;}
 window.openPost=openPost;
 function showUserTask(){
  const uid=current(),u=user(uid),box=$('user-task-result');
  const pending=(u.pendingTasks||[]).filter((t,index,all)=>!t.historicalContinuation&&!t.noticeDismissed&&all.findIndex(other=>other.id===t.id)===index&&ReaderEntityActions.canContinue(t)&&!ReaderEntityActions.isMiddleGap(t)&&(state.category==='posts'?t.query?.mode==='user-posts':t.query?.mode!=='user-posts'));
  box.hidden=!uid||!pending.length;if(box.hidden){box.replaceChildren();delete box.dataset.resumeKey;window.syncTaskNoticePresentation?.();return;}
  function syncNotice(){
   const first=[...box.children].find(item=>!item.hidden);
   box.hidden=!first;
   for(const item of box.children)item.classList.toggle('is-secondary-notice',item!==first);
  }
  const key=JSON.stringify([state.workspace,uid,state.category,state.busy,state.starting,pending.map(ReaderEntityActions.taskNoticeKey)]);
  if(box.dataset.resumeKey===key){syncNotice();window.syncTaskNoticePresentation?.();return;}
  box.dataset.resumeKey=key;box.replaceChildren();
  const groups=ReaderEntityActions.groupTasks(pending);for(const {task,count} of groups){
   const item=node('div','resume-task'),copy=node('div','resume-task-copy'),directions=task.progressStatus?.directions||[],names={sent:'发出',received:'收到','mentions-comments':'评论中的 @','mentions-posts':'微博中的 @','user-posts':'微博'};
   const title=node('strong','',ReaderAcquisitionFeedback.interruptedTask(task)?'原任务意外中断':'待补区间');
   for(const [i,d] of directions.entries())title.append(i?'，':'：',markCommentDirection(node('span','',(names[d.kind]||d.kind)+' '+numeric(d.covered)+(Number.isFinite(d.budget)?' / '+numeric(d.budget):'')+' 条'),d.kind));
   copy.append(title,node('p','field-hint','可从已保存的位置读取。'));
   if(pending.length>1)copy.append(node('p','field-hint',(count>1?'同类未完成任务共 '+count+' 项。':'')+'全部 '+pending.length+' 项可在获取历史查看。'));
   const reason=directions.map(d=>d.reason).filter(Boolean).join('；');if(reason){const detail=node('details','resume-task-reason');detail.append(node('summary','','上次停止原因'),node('p','field-hint',reason));copy.append(detail);}
   const resume=button(ReaderAcquisitionFeedback.continuationLabel(task),'button secondary resume-original',()=>{ReaderEntityActions.resumeTask(task.id);});resume.dataset.taskId=task.id;resume.disabled=state.busy||state.starting;item.dataset.taskId=task.id;item.append(copy,resume);
   box.append(item);
   window.ReaderNotices?.decorate(item,{...ReaderEntityActions.taskNoticeOptions('user',uid,task),
    label:'忽略提醒',
    onVisibilityChange:syncNotice,onDismiss:()=>{renderHome();renderTaskActivity();}});

  }
  syncNotice();window.syncTaskNoticePresentation?.();
 }

 function noticeTask(query,taskId){const kind=query?.mode==='post-comments'||query?.subject?.kind==='post'?'post':'user',id=kind==='post'?ReaderUX.postId(query.subject?.id||query.target):ReaderUX.uid(query?.subject?.uid||query?.target),entry=kind==='post'?(state.posts||[]).find(p=>p.postId===id):user(id);return {kind,id,task:entry?.pendingTasks?.find(t=>t.id===taskId&&!t.resumedBy)};}
 window.hasTaskContinuation=(query,taskId)=>{const {kind,task}=noticeTask(query,taskId);return kind==='user'&&!!task&&task.status!=='running'&&task.progressStatus?.resumable!==false;};
 window.taskPresentationOptions=(query,taskId,result)=>{const value=noticeTask(query,taskId);if(!value.id||!taskId)return {};const task=value.task||{id:taskId,query,status:result?.outcome?.state,summary:result?.summary};return ReaderEntityActions.taskNoticeOptions(value.kind,value.id,task);};
 window.renderUserContinuation=showUserTask;
 window.renderUserHome=renderHome;
 window.userCenterReceive=e=>{if(ReaderEntityActions.receive(e,'user'))renderHome();if(e.type==='homeUsers'){state.homeUsers=e.users||[];renderHome();renderFavorites();}if(e.type==='userAdded')openUser(e.uid);if(e.type==='started'&&e.kind==='collect'&&!e.automatic){state.runningQuery=JSON.parse(JSON.stringify(e.query));state.runningId=e.id;$('running-owner').hidden=false;$('running-owner').title=(e.query.mode==='post-comments'?'博文 '+ReaderUX.postId(e.query.target):user(ReaderUX.uid(e.query.target)).nickname+' · UID '+ReaderUX.uid(e.query.target))+'。切换页面时，任务会继续运行。';}
 if(e.type==='summary'&&e.syncOnly){state.userResults??={};state.userResults[e.uid]=e;if(e.uid===current())showUserTask();}
 if(e.type==='finished'&&e.kind==='collect'&&!e.automatic){$('running-owner').hidden=true;state.runningQuery=null;state.runningId=null;if(current())showUserTask();}
 if(e.type==='localData'&&e.requestId===state.localRequest&&current()&&e.summary?.latestInteractionMs)send({action:'userViewed',uid:current(),metadata:{nickname:e.label,latestInteractionMs:e.summary.latestInteractionMs}});
 };
 $('home-search').addEventListener('input',renderHome);all('[data-home-filter]').forEach(el=>el.addEventListener('click',()=>{homeFilter=el.dataset.homeFilter;renderHome();}));$('home-add').addEventListener('submit',e=>{e.preventDefault();const uid=ReaderUX.uid($('home-add-uid').value);if(!uid){toast('请输入有效的 UID 或用户主页链接',true);return;}send({action:'userAdd',uid});});$('user-home-back').onclick=()=>view(state.selection?.kind==='post'?'posts-home':'home');
 window.userSearch=()=>{view('home');$('home-search').focus();};renderHome();view('home');
})();
