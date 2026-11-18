'use strict';
function classifyOwnership(rows,targetUid){
 const owners=new Map();for(const r of rows){if(!r.postId||!r.postAuthorUid)continue;if(!owners.has(r.postId))owners.set(r.postId,new Set());owners.get(r.postId).add(r.postAuthorUid);}
 return rows.map(r=>{const known=owners.get(r.postId),owner=known?.size===1?[...known][0]:known?.size>1?'':r.postAuthorUid||'',ownership=!owner?'unknown':owner===targetUid?'target':'other',location=ownership!=='other'?'':!r.peerUid||r.peerUid===targetUid?'unknown':owner===r.peerUid?'peer':'third';return {...r,postOwnerUid:owner,ownership,location};});
}
function installOwnership(classify){
 if(document.body.dataset.ownershipVersion||document.body.dataset.colorMode!=='users'||!document.querySelector('.ranking')||!document.getElementById('conversation'))return;
 const modern=document.body.dataset.readerVersion==='2',items=[...document.querySelectorAll('#conversation [data-item]')];let portable=[];try{portable=JSON.parse(document.getElementById('weibo-report-records')?.textContent||'{}').rows||[];}catch{}if((!items.length&&!portable.length)||portable.some(r=>r.group?.startsWith('mentions-'))||items.some(i=>i.dataset.kind?.includes('@')))return;
 document.body.dataset.ownershipVersion='1';
 const target=document.body.dataset.targetUid||'',peerSelect=document.getElementById('peer'),q=document.getElementById('q'),type=document.getElementById('type'),panel=document.querySelector('.ranking');
 if(!target||!peerSelect||!q||!type)return;
 const field=(item,label)=>[...item.querySelectorAll('.record-details-body dl div')].find(d=>d.querySelector('dt')?.textContent===label)?.querySelector('dd');
 const uid=dd=>dd?.querySelector('a.user-link')?.getAttribute('href')?.match(/\/u\/(\d+)$/)?.[1]||'';
 const shared=portable.some(r=>r.shareView);
 const rows=classify(modern&&portable.length?portable.map((r,index)=>({...r,index:String(index),direction:r.interactionDirection||'other'})):items.map(item=>{const stored=portable[Number(item.dataset.record)],key=item.dataset.peer||'',peerUid=key.startsWith('uid:')?key.slice(4):'';
  if(stored)return {...stored,index:item.dataset.record,peerKey:key,peerUid,peerName:stored.peerName||peerUid,direction:stored.interactionDirection||'other'};
  const author=field(item,'评论作者'),source=field(item,'原微博作者'),recipient=field(item,'回复对象');return {index:item.dataset.record,recordId:item.dataset.commentId,postId:field(item,'原微博 ID')?.textContent.trim()||'',postAuthorUid:uid(source),peerUid,peerKey:key,peerName:(uid(author)===peerUid?author:uid(recipient)===peerUid?recipient:uid(source)===peerUid?source:null)?.querySelector('a')?.textContent||peerUid,type:item.dataset.kind,direction:item.dataset.authorUid===target||['发出','发出的评论'].includes(item.dataset.kind)?'sent':['收到','收到的评论','发出/收到'].includes(item.dataset.kind)?'received':'other',ms:Date.parse(item.querySelector('time[datetime]')?.dateTime||'')};}),target);
 const mapping=new Map(rows.map(r=>[r.index,r]));
 const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
 const controls=make('div',null,'ownership-controls'),label=make('label','原微博归属 '),scope=make('select'),location=make('select'),summary=make('p',null,'ownership-summary');scope.id='post-ownership';scope.setAttribute('aria-label','原微博归属');location.id='post-location';location.setAttribute('aria-label','他人微博的作者');
 for(const [v,t]of [['all','全部微博'],['other','他人微博下'],['target','目标用户的微博下'],['unknown','原作者未确认']]){const e=make('option',t);e.value=v;scope.append(e);}
 for(const [v,t]of [['all','全部他人微博'],['peer','互动对象自己的微博'],['third','第三方用户的微博'],['unknown','互动对象未确认']]){const e=make('option',t);e.value=v;location.append(e);}
 label.append(scope);controls.append(label,location);panel.querySelector('.ranking-heading').after(controls,summary);location.hidden=true;
 const style=make('style');style.textContent='.ownership-controls{display:flex;flex-wrap:wrap;gap:10px;padding:0 20px 10px;color:#61728a;font-size:12px}.ownership-controls select{padding:6px 9px;border:1px solid #d7e1ed;border-radius:6px;background:white;color:#334b67}.ownership-summary{padding:0 20px 12px;margin:0;color:#64758b;font-size:12px;line-height:1.8}';document.head.append(style);
 const allowed=r=>scope.value==='all'||r.ownership===scope.value&&(scope.value!=='other'||location.value==='all'||r.location===location.value);
 function rebuild(){
  location.hidden=scope.value!=='other';const selected=rows.filter(allowed),users=new Map();let unknown=0,self=0;
  const counts={target:0,other:0,unknown:0,peer:0,third:0,unconfirmed:0};for(const r of selected){counts[r.ownership]++;if(r.ownership==='other')counts[r.location==='unknown'?'unconfirmed':r.location]++;if(!r.peerUid){if(r.peerKey==='self')self++;else unknown++;continue;}const u=users.get(r.peerUid)||{uid:r.peerUid,name:r.peerName,sent:0,received:0,total:0};u.total++;if(r.direction==='sent')u.sent++;else if(r.direction==='received')u.received++;users.set(r.peerUid,u);}
  summary.textContent=`当前归属范围：${selected.length} 条独立评论 · ${new Set(selected.map(r=>r.postId).filter(Boolean)).size} 条已识别原微博。`+(scope.value==='other'?`互动对象自己的微博 ${counts.peer} 条 · 第三方微博 ${counts.third} 条 · 互动对象未确认 ${counts.unconfirmed} 条。`:`目标用户的微博 ${counts.target} 条 · 他人微博 ${counts.other} 条 · 原作者未确认 ${counts.unknown} 条。`)+`仅表示互动所在位置；${unknown} 条对象未确认，${self} 条自身互动另计。`;
  panel.querySelector('.ranking-heading p').textContent=`${users.size} 位用户 · ${selected.length-unknown-self} 条可归属互动记录`;
  panel.querySelector('.scope-label').textContent=scope.options[scope.selectedIndex].textContent;
  let scroll=panel.querySelector('.rank-scroll');if(!scroll){scroll=make('div',null,'rank-scroll');panel.querySelector('.counting-note').before(scroll);}scroll.replaceChildren();panel.querySelector('.rank-empty')?.remove();
  const table=make('table',null,'rank-table'),head=make('thead'),hrow=make('tr'),body=make('tbody');for(const t of ['排名','用户',shared?'本人留言':'发出',shared?'他人留言':'收到','合计','记录'])hrow.append(make('th',t));head.append(hrow);table.append(head,body);scroll.append(table);
  const ranked=[...users.values()].sort((a,b)=>b.total-a.total||a.uid.localeCompare(b.uid));
  for(const [i,u]of ranked.entries()){
   const tr=make('tr'),user=make('td',null,'rank-user'),link=make('a',u.name||u.uid,'user-link');link.href='https://weibo.cn/u/'+u.uid;link.target='_blank';link.rel='noopener noreferrer';link.dataset.userId=u.uid;const line=make('span','UID '+u.uid,'uid'),copy=make('button','复制 UID','copy-id');copy.type='button';copy.dataset.originCopy=u.uid;line.append(copy);const track=make('span',null,'rank-track'),bar=make('span',null,'rank-bar');bar.style.width=Math.round(u.total/(ranked[0]?.total||1)*100)+'%';track.append(bar);user.append(link,line,track);const cell=make('td'),button=make('button','查看对话','rank-filter');button.type='button';button.dataset.originPeer=u.uid;cell.append(button);tr.append(make('td',String(i+1),'rank-number'),user,make('td',String(u.sent)),make('td',String(u.received)),make('td',u.total+' 条','rank-total'),cell);body.append(tr);
  }
  window.ReaderAccountColors?.apply(panel);
 }
 function filter(){
  if(modern){document.dispatchEvent(new CustomEvent('reader-ownership',{detail:{ids:rows.filter(allowed).map(r=>r.index),active:scope.value!=='all'}}));return;}
  const needle=q.value.trim().toLowerCase();let active=0,contexts=0;
  for(const pane of document.querySelectorAll('[data-view]')){
   const shown=new Set(),eligible=new Set();let count=0,refs=0;
   for(const item of pane.querySelectorAll('[data-item]')){const r=mapping.get(item.dataset.record),pass=r&&allowed(r)&&(!type.value||item.dataset.kind===type.value)&&(!peerSelect.value||item.dataset.peer===peerSelect.value);if(pass)eligible.add(item.dataset.record);item.hidden=!(pass&&(!needle||item.dataset.search.toLowerCase().includes(needle)));if(!item.hidden){shown.add(item.dataset.record);count++;}}
   for(const item of pane.querySelectorAll('[data-context]')){const ids=(item.dataset.contextFor||'').split(',');item.hidden=!(ids.some(id=>shown.has(id))||needle&&ids.some(id=>eligible.has(id))&&item.dataset.search.toLowerCase().includes(needle));if(!item.hidden)refs++;}
   for(const day of pane.querySelectorAll('[data-day-group]')){let next=day.nextElementSibling,visible=false;while(next&&!next.matches('[data-day-group]')){if(next.matches('[data-item],[data-context]')&&!next.hidden){visible=true;break;}next=next.nextElementSibling;}day.hidden=!visible;}
   for(const group of pane.querySelectorAll('[data-branch-group],[data-post-group],[data-thread]')){const messages=[...group.querySelectorAll('[data-item]')],n=messages.filter(x=>!x.hidden).length,c=[...group.querySelectorAll('[data-context]')].filter(x=>!x.hidden).length;group.hidden=!n&&!c;const badge=group.firstElementChild?.querySelector('[data-group-count]');if(badge)badge.textContent=n+' 条'+(c?' + '+c+' 引用':'');if(scope.value!=='all'&&(n||c)&&group.tagName==='DETAILS')group.open=true;}
   if(!pane.hidden){active=count;contexts=refs;}
  }
  document.getElementById('stats').textContent='显示 '+active+' / '+rows.filter(allowed).length+' 条'+(contexts?' · '+(shared?'前文':'引用补充')+' '+contexts+' 条':'');document.getElementById('empty-state').hidden=active+contexts>0;
 }
 for(const el of [scope,location])el.addEventListener('change',()=>{peerSelect.value='';rebuild();filter();});
 if(!modern){document.addEventListener('input',e=>{if(e.target===q)filter();});document.addEventListener('change',e=>{if(e.target===type||e.target===peerSelect)filter();});}
 document.addEventListener('click',async e=>{
  const copy=e.target.closest('[data-origin-copy]');if(copy){e.preventDefault();const value=copy.dataset.originCopy;let ok=false;try{await navigator.clipboard.writeText(value);ok=true;}catch{}if(!ok){const t=make('textarea');t.value=value;t.style.cssText='position:fixed;left:-9999px';document.body.append(t);t.select();try{ok=document.execCommand('copy');}catch{}t.remove();}copy.textContent=ok?'已复制':'复制失败';setTimeout(()=>copy.textContent='复制 UID',1800);return;}
  const b=e.target.closest('[data-origin-peer]');if(b){peerSelect.value='uid:'+b.dataset.originPeer;q.value='';type.value='';document.querySelector('[data-view-button="conversation"]')?.click();document.getElementById('record-toolbar').scrollIntoView({block:'start'});}
  if(e.target.closest('#clear')){scope.value='all';location.value='all';rebuild();if(modern)filter();}
  if(!modern&&(b||e.target.closest('[data-view-button],[data-dialog-order],#clear,[data-peer-button]')))filter();
 });
 const note=panel.querySelector('.counting-note ul');if(note){const final=note.lastElementChild;final.textContent='统计范围：排行榜随“原微博归属”及其作者分类切换；搜索、评论类型和互动对象筛选只改变下方阅读内容。原作者 UID 无法确认的记录单列，不按昵称推断归属。';}
 rebuild();filter();
}
const OWNERSHIP_SCRIPT=';('+installOwnership.toString()+')('+classifyOwnership.toString()+');';
module.exports={classifyOwnership,installOwnership,OWNERSHIP_SCRIPT};
