'use strict';
// Serialized into standalone HTML; all dependencies are pure view templates.
function startReader(){
 const payload=JSON.parse(document.getElementById('weibo-report-records').textContent),rows=payload.rows;if(payload.paged||rows.length>200){startPagedReader(payload);return;}
 const q=document.getElementById('q'),type=document.getElementById('type'),peer=document.getElementById('peer'),direction=document.getElementById('direction'),stats=document.getElementById('stats');
 const buttons=[...document.querySelectorAll('[data-view-button]')],views=[...document.querySelectorAll('[data-view]')],indexed=new Map();
 const renderers={timeline:timelineHtml};
 const contextName=rows.some(r=>r.shareView)?'前文':'引用补充';
 let onlyNew=!!payload.updateInfo&&rows.some(r=>r.isNew),newPosition=-1;
 let view='conversation',dialogOrder=null,ownership=null,searchTimer=null,filterFrame=null,composing=false;
 const current=Date.now()+8*3600000;
 const today=new Date(current).toISOString().slice(0,10),yesterday=new Date(current-86400000).toISOString().slice(0,10);
 const dayLabel=day=>day===today?'今天 · '+day:day===yesterday?'昨天 · '+day:day;
 function indexPane(pane){
  const formal=[...pane.querySelectorAll('[data-item]')],contexts=[...pane.querySelectorAll('[data-context]')];
  const entries=[...formal,...contexts],byNode=new Map();
  for(const node of entries){
   // Search strings are decoded/lowercased once, not on every keystroke.
   if(!node.readerSearch)node.readerSearch={text:(node.dataset.search||'').toLowerCase(),id:node.dataset.record,isNew:node.dataset.new==='1',kind:node.dataset.kind,peer:node.dataset.peer,refs:(node.dataset.contextFor||'').split(',')};
   byNode.set(node,node.readerSearch);
  }
  const days=[...pane.querySelectorAll('[data-day-group]')].map(node=>{
   const messages=[];for(let n=node.nextElementSibling;n&&!n.matches('[data-day-group]');n=n.nextElementSibling)if(byNode.has(n))messages.push(n);
   const label=node.querySelector('[data-day]');if(label)label.textContent=dayLabel(label.dataset.day);return {node,messages};
  });
  const branches=[...pane.querySelectorAll('[data-branch-group]')].map(node=>({node,messages:[...node.querySelectorAll('[data-item],[data-context]')]}));
  const groups=[...pane.querySelectorAll('[data-post-group],[data-thread]')].map(node=>({node,formal:[...node.querySelectorAll('[data-item]')],contexts:[...node.querySelectorAll('[data-context]')],badge:node.firstElementChild.querySelector('[data-group-count]')}));
  const result={pane,formal,contexts,days,branches,groups};indexed.set(pane.dataset.view,result);return result;
 }
 function ensureView(name){
  if(indexed.has(name))return indexed.get(name);
  const pane=document.getElementById(name);pane.innerHTML=renderers[name](rows);
  const result=indexPane(pane);document.dispatchEvent(new CustomEvent('reader-view-ready',{detail:{pane}}));return result;
 }
 // Keep the default view readable without JavaScript. Alternate views share
 // the same normalized snapshot and are built once, only when selected.
 indexPane(document.getElementById('conversation'));
 // Keep each group's original chronological message list independently of its
 // current DOM layout. Branch mode nests messages inside sections; rediscovering
 // only direct children when another lazy group opens would discard earlier rows.
 const messageLists=new WeakMap();let conversationBodies=[];
 function refreshBodies(){conversationBodies=indexed.get('conversation').groups.map(({node})=>{const body=node.querySelector('.thread-body');if(!messageLists.has(body))messageLists.set(body,[...body.querySelectorAll('[data-item],[data-context]')]);return {body,messages:messageLists.get(body)};});}
 refreshBodies();
 function hydrate(group,reorder=true){const source=group.querySelector('[data-lazy-thread]');if(!source)return false;const body=group.querySelector('.thread-body');body.innerHTML=JSON.parse(source.textContent);source.remove();messageLists.delete(body);indexPane(document.getElementById('conversation'));refreshBodies();document.dispatchEvent(new CustomEvent('reader-view-ready',{detail:{pane:group}}));if(reorder){const mode=dialogOrder||'branches';dialogOrder=null;setOrder(mode);}return true;}
 document.getElementById('conversation').addEventListener('toggle',event=>{if(event.target.matches('[data-post-group]')&&event.target.open)hydrate(event.target);},true);
 const orderButtons=[...document.querySelectorAll('button[data-dialog-order]')];
 function setOrder(mode){
  if(!['time','branches'].includes(mode)||dialogOrder===mode)return;dialogOrder=mode;
  for(const {body,messages}of conversationBodies)layoutConversation(body,messages,mode,dayLabel);
  for(const button of orderButtons)button.setAttribute('aria-pressed',String(button.dataset.dialogOrder===mode));document.getElementById('conversation').dataset.dialogOrder=mode;indexPane(document.getElementById('conversation'));scheduleFilter();
 }
 function hide(node,value){if(node.hidden!==value)node.hidden=value;}
 function visibleFilter(){
  filterFrame=null;const needle=q.value.trim().toLowerCase(),active=!!(needle||type.value||peer.value||ownership||onlyNew||direction?.value),pane=ensureView(view),visible=new Set(),eligible=new Set();let count=0,contextCount=0;if(active&&view==='conversation'){let changed=false;for(const g of [...pane.groups])changed=hydrate(g.node,false)||changed;if(changed){const mode=dialogOrder||'branches';dialogOrder=null;setOrder(mode);return;}}
  for(const item of pane.formal){const d=item.readerSearch,allowed=(!onlyNew||d.isNew)&&(!ownership||ownership.has(d.id))&&(!type.value||d.kind===type.value)&&(!peer.value||d.peer===peer.value)&&(!direction?.value||matchesDirection(rows[Number(d.id)],direction.value));if(allowed)eligible.add(d.id);const match=allowed&&(!needle||d.text.includes(needle));hide(item,!match);if(match){count++;visible.add(d.id);}}
  const readingVisible=new Set(visible);for(const item of pane.formal){item.classList.remove('direction-context');delete item.dataset.directionContext;item.querySelector('.direction-context-badge')?.remove();}
  if(direction?.value&&view==='conversation'){
   const lookup=new Map(rows.flatMap((r,i)=>r.group==='mentions-posts'?[]:[[r.postId+':'+r.recordId,i]])),parents=new Set();
   for(const index of visible){const row=rows[Number(index)];let id=row.replyId||row.rootId;const seen=new Set();for(let n=0;n<3&&id&&!seen.has(id);n++){seen.add(id);const i=lookup.get(row.postId+':'+id),parent=rows[i];if(i==null||parent.ms>row.ms||parent.recordId===row.recordId)break;if(!visible.has(String(i)))parents.add(String(i));id=parent.replyId;}}
   for(const item of pane.formal)if(parents.has(item.readerSearch.id)){hide(item,false);readingVisible.add(item.readerSearch.id);contextCount++;item.classList.add('direction-context');item.dataset.directionContext='1';const badge=document.createElement('span');badge.className='context-badge direction-context-badge';badge.textContent='前文';badge.title='仅保留为阅读上下文，不计入当前筛选条数';item.querySelector('.bubble-meta')?.append(badge);}
  }
  for(const item of pane.formal)if(!visible.has(item.readerSearch.id))item.classList.remove('unread-record-focus');
  for(const context of pane.contexts){const d=context.readerSearch,linked=d.refs.some(id=>readingVisible.has(id)),direct=!!needle&&d.refs.some(id=>eligible.has(id))&&d.text.includes(needle);hide(context,!(linked||direct));if(!context.hidden)contextCount++;}
  for(const {node,messages}of pane.days)hide(node,!messages.some(m=>!m.hidden));
  for(const {node,messages}of pane.branches)hide(node,!messages.some(m=>!m.hidden));
  for(const group of pane.groups){const shown=group.formal.reduce((n,m)=>n+(!m.hidden&&!m.dataset.directionContext),0),refs=group.contexts.reduce((n,m)=>n+!m.hidden,0)+group.formal.reduce((n,m)=>n+(!m.hidden&&!!m.dataset.directionContext),0);hide(group.node,shown+refs===0&&!group.node.querySelector('[data-lazy-thread]'));if(group.badge&&!group.node.querySelector('[data-lazy-thread]')){const label=(shown===group.formal.length?shown+' 条':shown+' / '+group.formal.length+' 条')+(refs?' + '+refs+' 引用':'');if(group.badge.textContent!==label)group.badge.textContent=label;}if(typeof updateUnreadSummary==='function'&&!group.node.querySelector('[data-lazy-thread]'))updateUnreadSummary(group.node,group.formal.filter(n=>!n.hidden&&!n.dataset.directionContext).map(n=>rows[Number(n.dataset.record)]));if(active&&(shown||refs))group.node.open=true;}
  if(!active&&view==='conversation')count=rows.length;stats.textContent='显示 '+count+' / '+(ownership?ownership.size:rows.length)+' 条'+(contextCount?' · '+contextName+' '+contextCount+' 条':'');document.getElementById('empty-state').hidden=count+contextCount!==0;
  for(const button of document.querySelectorAll('[data-peer-button]'))button.setAttribute('aria-pressed',String(button.dataset.peerButton===peer.value));
 }
 function scheduleFilter(delay=0){clearTimeout(searchTimer);if(delay){searchTimer=setTimeout(()=>scheduleFilter(),delay);return;}if(filterFrame==null)filterFrame=requestAnimationFrame(visibleFilter);}
 function switchView(name){if(name!=='conversation'&&!Object.hasOwn(renderers,name))return;view=name;ensureView(name);for(const pane of views)pane.hidden=pane.dataset.view!==name;for(const button of buttons){const selected=button.dataset.viewButton===name;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}scheduleFilter();}
 for(const button of buttons){button.addEventListener('click',()=>switchView(button.dataset.viewButton));button.addEventListener('keydown',event=>{let i=buttons.indexOf(button);if(event.key==='ArrowRight')i=(i+1)%buttons.length;else if(event.key==='ArrowLeft')i=(i+buttons.length-1)%buttons.length;else if(event.key==='Home')i=0;else if(event.key==='End')i=buttons.length-1;else return;event.preventDefault();switchView(buttons[i].dataset.viewButton);buttons[i].focus();});}
 for(const button of orderButtons)button.addEventListener('click',()=>setOrder(button.dataset.dialogOrder));
 document.addEventListener('reader-ownership',event=>{ownership=event.detail.active?new Set(event.detail.ids):null;scheduleFilter();});
 document.addEventListener('click',event=>{const badge=event.target.closest('[data-unread-jump]');if(!badge)return;event.preventDefault();event.stopPropagation();const group=badge.closest('[data-post-group]');if(!group)return;const navigation=beginUnreadNavigation();hydrate(group);group.open=true;requestAnimationFrame(()=>{if(navigation.signal.aborted)return;visibleFilter();const candidates=[...group.querySelectorAll('[data-item]')].filter(n=>!n.dataset.directionContext&&!n.closest('[hidden]')&&unreadDirection(rows[Number(n.dataset.record)])===badge.dataset.unreadJump),target=candidates.reduce((first,n)=>!first||(rows[Number(n.dataset.record)].ms??Infinity)<(rows[Number(first.dataset.record)].ms??Infinity)?n:first,null);focusUnreadRecord(target,navigation);});});
 document.addEventListener('click',event=>{const button=event.target.closest('[data-peer-button]');if(!button)return;q.value='';type.value='';peer.value=button.dataset.peerButton;switchView('conversation');document.getElementById('record-toolbar').scrollIntoView({behavior:'smooth',block:'start'});});
 q.addEventListener('compositionstart',()=>{composing=true;clearTimeout(searchTimer);});q.addEventListener('compositionend',()=>{composing=false;scheduleFilter(120);});q.addEventListener('input',()=>{if(!composing)scheduleFilter(120);});type.addEventListener('change',()=>scheduleFilter());direction?.addEventListener('change',()=>scheduleFilter());peer.addEventListener('change',()=>scheduleFilter());
 document.getElementById('clear').addEventListener('click',()=>{q.value='';type.value='';peer.value='';if(direction)direction.value='';scheduleFilter();q.focus();});
 function setDialogs(open){let changed=false;for(const {node}of [...indexed.get('conversation').groups])if(!node.hidden){if(open)changed=hydrate(node,false)||changed;node.open=open;}if(changed){const mode=dialogOrder||'branches';dialogOrder=null;setOrder(mode);}}
 document.getElementById('expand-all').addEventListener('click',()=>setDialogs(true));document.getElementById('collapse-all').addEventListener('click',()=>setDialogs(false));
 function newScope(value){onlyNew=value;newPosition=-1;document.getElementById('new-only')?.setAttribute('aria-pressed',String(value));document.getElementById('new-all')?.setAttribute('aria-pressed',String(!value));scheduleFilter();}
 document.getElementById('new-only')?.addEventListener('click',()=>newScope(true));document.getElementById('new-all')?.addEventListener('click',()=>newScope(false));
 function jumpNew(delta){const candidates=ensureView(view).formal.filter(n=>n.dataset.new==='1'&&!n.hidden);if(!candidates.length)return;newPosition=newPosition<0?(delta>0?0:candidates.length-1):(newPosition+delta+candidates.length)%candidates.length;const target=candidates[newPosition];for(const n of document.querySelectorAll('.new-record-focus'))n.classList.remove('new-record-focus');target.classList.add('new-record-focus');for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;target.scrollIntoView({block:'center',behavior:'smooth'});}
 document.getElementById('new-prev')?.addEventListener('click',()=>jumpNew(-1));document.getElementById('new-next')?.addEventListener('click',()=>jumpNew(1));
 setOrder('branches');
}
module.exports={startReader};
