'use strict';
(()=>{
 let homeFilter='all',homeDirty=false,avatarJob=null,avatarIssue=null,postVisit=0;state.posts??=[];const current=()=>state.selection?.kind==='post'?ReaderUX.postId(state.selection.target):'';
 const avatarScope=ReaderWorkspaceChannel.createScope(()=>state.workspace);
 const avatarOwner=owner=>avatarScope.owns(owner)&&owner.visit===postVisit&&state.view==='create'&&current()===owner.postId&&state.posts.find(post=>post.postId===owner.postId)?.authorUid===owner.authorUid;
 function refreshAuthorAvatar(owner,allowPaidLookup=false){
  if(avatarJob||!avatarOwner(owner))return;
  avatarIssue=null;
  avatarJob={...owner,requestId:crypto.randomUUID(),allowPaidLookup};
  identity();
  send({action:'postAuthorAvatar',postId:owner.postId,authorUid:owner.authorUid,requestId:avatarJob.requestId,allowPaidLookup});
 }
 function avatarResult(e){
  const owner=avatarJob;
  if(!owner||e.requestId!==owner.requestId||e.workspace!==owner.workspace||!avatarScope.owns(owner,e))return;
  if(e.type==='postAuthorAvatarResult'&&(e.postId!==owner.postId||e.authorUid!==owner.authorUid))return;
  avatarJob=null;
  if(!avatarOwner(owner))return;
  if(!e.updated&&!e.cancelled)avatarIssue={...owner,code:e.code,message:e.message};
  identity();
 }
 async function avatarDetails(owner){
  if(!avatarOwner(owner)||avatarIssue!==owner)return;
  if(!owner.allowPaidLookup&&owner.code==='POST_AUTHOR_AVATAR_PROOF_UNAVAILABLE'){
   const yes=await confirmManagement('通过 WeiboCLI 获取作者头像？','本地没有可核对的头像地址。可以按原资料查询规则更新此作者的头像（UID '+owner.authorUid+'），可能消耗 credits。不会读取评论或开启订阅。','通过 WeiboCLI 更新');
   if(yes)refreshAuthorAvatar(owner,true);
  }else ReaderEntityActions.statusDetails('作者头像未能补齐',owner.message||'暂时未取得已确认作者的头像。');
 }
 const panel=node('section','user-identity');panel.id='post-identity';panel.hidden=true;$('user-identity').after(panel);
 function identity(){
  const id=current();if(!id){panel.hidden=true;return;}const post=state.posts.find(p=>p.postId===id)||{postId:id,title:'微博 '+id};panel.hidden=false;
  const main=node('div','post-identity-main'),title=node('strong','post-identity-title',ReaderEntityActions.displayName(post,post.author?post.author+' 的博文':'博文'));title.title=[post.author,post.title].filter(Boolean).join(' · ');
  if(window.entityAvatar)main.append(entityAvatar('post',id));main.append(title,node('span','current-user-uid','微博 ID '+id));
  if(post.note?.trim())main.append(node('span','post-original-author','发布用户：'+(post.author||'未知作者')));
  const buttons=node('div','user-page-actions');buttons.append(ReaderEntityActions.external('post',id),ReaderEntityActions.noteButton('post',id),button((state.postFavorites||[]).includes(id)?'★ 已特别关注':'☆ 特别关注','text-button'+((state.postFavorites||[]).includes(id)?' is-favorite':''),()=>send({action:'postFavorite',postId:id,on:!(state.postFavorites||[]).includes(id)})),button('复制微博 ID','text-button',()=>send({action:'copy',text:id})),button('获取历史','text-button',()=>showHistory(id,'post-comments')));
  if(post.authorUid&&ReaderUX.uid(post.authorUid)===post.authorUid){
   const owner=avatarScope.capture({postId:id,authorUid:post.authorUid,visit:postVisit});
   const action=node('span','post-author-avatar-action'),refresh=button('补齐作者头像','text-button post-author-avatar-refresh',()=>refreshAuthorAvatar(owner));
   const loaded=!!main.querySelector('.user-avatar img');
   refresh.disabled=loaded||!!avatarJob;refresh.title=loaded?'已载入本地作者头像':avatarJob?'正在核对作者头像…':'先使用本地资料；只有确认后才会发起可能计费的资料查询';
   action.append(refresh);
   if(!loaded&&avatarIssue&&avatarOwner(avatarIssue)){
    const issue=avatarIssue,info=button('i','row-notices-toggle post-author-avatar-info',()=>void avatarDetails(issue));
    info.setAttribute('aria-label','查看作者头像补齐说明');info.title='查看作者头像补齐说明';action.append(info);
   }
   buttons.append(action);
  }
  panel.replaceChildren(main,buttons);window.renderSubscriptionToggle?.('post',id);
  ReaderEntityActions.renderContinuations('post',id);
 }

 ReaderEntityActions.installClearNotices($('post-list-toolbar'),()=>state.posts.flatMap(p=>
  (p.pendingTasks||[]).filter(ReaderEntityActions.canContinue).flatMap(task=>ReaderEntityActions.taskAcknowledgments('post',p.postId,task))
 ));
 function renderHome(){homeDirty=false;const homeStatus=ReaderEntityActions.homeLoadStatus('posts','post-list-state',state.posts.length>0);const term=$('post-search').value.trim().toLowerCase(),root=$('post-home-list');root.setAttribute('role','list');root.replaceChildren();const rows=state.posts.filter(p=>(homeFilter!=='favorites'||(state.postFavorites||[]).includes(p.postId))&&(!term||[p.postId,p.title,p.author,p.note].join(' ').toLowerCase().includes(term))).sort((a,b)=>Number((state.postFavorites||[]).includes(b.postId))-Number((state.postFavorites||[]).includes(a.postId)));$('post-home-empty').hidden=!!rows.length||homeStatus!=='ready';$('post-home-empty').textContent=term?'没有匹配的博文，可以调整搜索。':homeFilter==='favorites'?'还没有关注的博文，可以点亮博文旁的星标。':'还没有博文，可以先添加链接；添加不会自动获取评论。';all('[data-post-filter]').forEach(el=>{const active=el.dataset.postFilter===homeFilter;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});for(const p of rows){const card=node('article','user-home-card'),heading=node('div','user-home-heading');const entry=button('','user-open post-card-open',()=>open(p.postId));entry.append(window.entityAvatar?entityAvatar('post',p.postId,'post-card-avatar'):node('span','user-avatar post-card-avatar',Array.from(p.author||'博文')[0]),node('strong','',ReaderEntityActions.displayName(p,p.author?p.author+' 的博文':'未知作者的博文')),node('span','muted post-card-id','微博 ID '+p.postId));heading.append(entry,button((state.postFavorites||[]).includes(p.postId)?'★':'☆','user-star'+((state.postFavorites||[]).includes(p.postId)?' is-favorite':''),()=>send({action:'postFavorite',postId:p.postId,on:!(state.postFavorites||[]).includes(p.postId)})),button('删除','text-button danger-button',()=>send({action:'manageDeletePlan',targets:[{targetKind:'post',id:p.postId}],requestId:crypto.randomUUID()})));card.dataset.targetId=p.postId;ReaderEntityActions.listRow(card,()=>open(p.postId));heading.querySelector('.user-open').title=[p.note,p.author,p.title,'微博 ID '+p.postId].filter(Boolean).join(' · ');entry.setAttribute('aria-label','打开博文 '+entry.title);const facts=node('div','post-card-facts'),author=ReaderEntityActions.fact('发布用户',p.author||'未知作者');author.classList.add('post-card-author');facts.append(author,ReaderEntityActions.fact('数据更新',p.updatedAt?relativeTime(p.updatedAt):p.hasData?'无已核实更新时间':'尚未获取评论',p.updatedAt?dateText(Date.parse(p.updatedAt)):''));const excerpt=node('p','post-card-excerpt',p.title||'暂无本地正文');excerpt.title=p.title||'暂无本地正文';const tasks=(p.pendingTasks||[]).filter(task=>!task.resumedBy),notices=ReaderEntityActions.taskNotices(tasks,p.pendingMessage,p.pendingDetail);if(tasks.some(task=>task.status==='running')){const status=facts.lastElementChild.querySelector('.card-fact-label');status.textContent='正在获取评论';status.classList.add('home-running');facts.lastElementChild.title=status.textContent+' · '+facts.lastElementChild.querySelector('.card-fact-value').textContent;}for(const star of heading.querySelectorAll('.user-star')){star.setAttribute('aria-label',(state.postFavorites||[]).includes(p.postId)?'取消特别关注':'特别关注');star.setAttribute('aria-pressed',String((state.postFavorites||[]).includes(p.postId)));}card.append(heading,excerpt,facts);card.append(ReaderEntityActions.actions('post',p.postId));ReaderEntityActions.noticeSlot(card,'post',p.postId,notices);root.append(card);}window.renderMultiSelect?.('post');}
 function open(value=''){postVisit++;ReaderEntityActions.close();const id=ReaderUX.postId(value);if(!id){view('posts-home');$('post-add-target').focus();return;}rememberFilters();ReaderIdentity.selectPost(state,id);state.category='post';state.task='sync';$('target').value=id;state.updateOperation='regular';syncUserFilters();view('create');updateForm();$('user-identity').hidden=true;$('local-results-title').textContent='本地评论';$('category-tabs').hidden=true;$('user-task-result').hidden=true;$('user-page-actions').hidden=true;$('user-target-field').hidden=true;$('user-page-title').textContent='博文评论';$('user-page-subtitle').textContent='读取这条博文下的评论；数据、报告与用户互动分开保存。';$('user-home-back').textContent='‹ 返回博文列表';$('user-home-back').setAttribute('aria-label','返回博文列表');$('user-home-back').hidden=false;identity();renderContextReports();}
 window.postAuthorAvatarReceive=e=>{
  if(e.type==='library'&&(avatarScope.observe(e)||e.homeBlocked)){avatarJob=null;avatarIssue=null;postVisit++;}
  if(e.type==='postAuthorAvatarResult'||(e.type==='foregroundRejected'||e.type==='foregroundDequeued'&&e.cancelled)&&e.action==='postAuthorAvatar'){avatarResult(e);return true;}
  if(['engineStopped','engineTransportError'].includes(e.type)&&avatarJob){avatarJob=null;if(current())identity();}
  if(e.type==='userProfile'&&e.workspace===state.workspace&&ReaderHomeAssets.valid(e.avatarData)&&state.posts.some(post=>post.authorUid===e.uid)){
   const old=state.postAuthors?.[e.uid];
   state.postAuthors={...state.postAuthors,[e.uid]:{...old,uid:e.uid,nickname:old?.nickname||e.nickname,avatarData:e.avatarData,avatarPending:false,profileNoticeId:e.profileNoticeId}};
  }
  return false;
 };
 window.postCenterOnView=name=>{if(name==='posts-home'&&homeDirty)renderHome();};window.renderPostHome=renderHome;window.openPostPage=open;window.renderContextReports=function(){
  const id=current(),uid=ReaderIdentity.user(state),box=$('context-reports'),root=$('context-report-list'),status=$('context-report-state');
  box.hidden=!id&&!uid;if(box.hidden)return;
  const reports=state.reports.filter(r=>id?r.category==='post-comments'&&r.postId===id:r.uid===uid&&r.category!=='post-comments').sort((a,b)=>b.modified-a.modified);
  const loading=state.homeLoading.reports,phase=loading?.status||'ready';
  const statusKey=JSON.stringify([state.workspace,id,uid,phase,loading?.message]);
  if(status.dataset.key!==statusKey){
   status.dataset.key=statusKey;status.hidden=phase==='ready';status.replaceChildren();
   status.setAttribute('role',phase==='error'?'alert':'status');
   ReaderEntityActions.retainedLoadStatus(status,phase,loading?.message,'报告列表',()=>send({action:'library'}));
  }
  const emptyText=reports.length?'':phase==='loading'&&!loading.snapshot?'正在读取本地报告列表…':phase==='error'&&!loading.snapshot?'报告列表暂不可用。':'还没有已生成报告；设置条数或日期后，生成并打开报告即可阅读。';
  const reportsKey=JSON.stringify([state.workspace,id,uid,emptyText,reports]);
  if(root.dataset.key===reportsKey)return;
  root.dataset.key=reportsKey;root.replaceChildren();
  if(!reports.length){root.append(node('p','field-hint',emptyText));return;}
  for(const report of reports.slice(0,3))root.append(reportRow(report));
  if(reports.length>3){
   const more=node('details');more.append(node('summary','',`其余 ${reports.length-3} 份报告`));
   for(const report of reports.slice(3))more.append(reportRow(report));root.append(more);
  }
 };
 window.postCenterReceive=e=>{if(ReaderEntityActions.receive(e,'post')){renderHome();if(current())identity();}if(e.type==='postDeleted'&&current()===e.postId){state.selection=null;state.formOwner=null;state.formTask=null;state.localResult=null;view('posts-home');}if(e.type==='postsHome'){state.posts=e.posts||[];renderHome();renderFavorites();if(current())identity();}if(e.type==='userProfile'||e.type==='homeUsers')queueMicrotask(()=>{if(state.view==='posts-home')renderHome();else homeDirty=true;if(current())identity();});if(e.type==='postAdded')open(e.postId);if(e.type==='library'){queueMicrotask(()=>{renderContextReports();if(current())identity();});}};
 $('post-add').addEventListener('submit',e=>{e.preventDefault();const target=$('post-add-target').value.trim();if(!ReaderUX.postId(target)){toast('请输入有效的微博 ID 或支持的微博链接',true);return;}send({action:'postAdd',target});});$('post-search').addEventListener('input',renderHome);all('[data-post-filter]').forEach(el=>el.addEventListener('click',()=>{homeFilter=el.dataset.postFilter;renderHome();}));renderHome();
})();
