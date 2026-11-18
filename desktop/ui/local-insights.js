'use strict';
// Location summaries only. Reading remains an independently generated browser HTML.
(()=>{
 let searchId='',timelineId='',openId='',objectId='',result=null,ownerUid='',timer,objects=[],activeQuery='';
 const status=$('global-search-status'),timeline=$('coverage-timeline'),controls=$('global-search-form');
 const id=()=>crypto.randomUUID(),query=()=>({text:$('global-search-text').value,author:$('global-search-author').value,owner:$('global-search-owner').value,from:$('global-search-from').value,to:$('global-search-to').value});
 function ownerText(key,label){const [category,identity]=key.split(':');return (category==='post-comments'?'博文评论':category==='posts'?'用户微博':'用户互动')+' · '+(label&&label!==identity?label+' · ':'')+(category==='post-comments'?'微博 ID ':'UID ')+identity;}
 function note(box,text,error=false){box.hidden=false;box.classList.remove('search-export-status');box.textContent=text;if(error)ReaderNotices.decorate(box,{key:id(),scope:state.workspace});else ReaderNotices.reset(box);}
 function launch(){clearTimeout(timer);openId='';activeQuery=JSON.stringify(query());send({action:'insightsCancel',scope:'search'});searchId=id();result=null;$('global-search-results').replaceChildren();$('global-search-pages').replaceChildren();if(!query().text.trim()){note(status,'输入关键词后搜索全部本地数据；可叠加日期、所属对象和作者条件。');return;}note(status,'索引准备中／搜索中… 可以取消，结果以完成后为准。');send({action:'globalSearch',requestId:searchId,query:query()});}
 function schedule(){if(searchId&&JSON.stringify(query())===activeQuery)return;clearTimeout(timer);searchId='';openId='';result=null;$('global-search-results').replaceChildren();$('global-search-pages').replaceChildren();note(status,'等待搜索…');send({action:'insightsCancel',scope:'search'});timer=setTimeout(launch,350);}
 function highlight(text,term){const box=node('span'),lower=text.toLocaleLowerCase(),q=term.trim().toLocaleLowerCase();let p=0,at=q?lower.indexOf(q):-1;while(at>=0){box.append(document.createTextNode(text.slice(p,at)),node('mark','',text.slice(at,at+q.length)));p=at+q.length;at=lower.indexOf(q,p);}box.append(document.createTextNode(text.slice(p)));return box;}
 function excerpt(value,term){const text=String(value||''),points=Array.from(text),needle=term.trim(),at=text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()),size=Math.max(240,Array.from(needle).length+80);if(points.length<=size)return text;const hit=at<0?0:Array.from(text.slice(0,at)).length,start=Math.max(0,hit-70),end=Math.min(points.length,start+size);return (start?'…':'')+points.slice(start,end).join('')+(end<points.length?'…':'');}
 function sourceLabel(source){const [category,identity]=source.owner.split(':'),kind=category==='post-comments'?'博文评论':category==='posts'?'用户微博':'用户互动';return kind+' · '+(source.label||((category==='post-comments'?'微博 ID ':'UID ')+identity));}
 function opened(e){const n=e.summary||{};note(status,'');status.classList.add('search-export-status');status.append(node('strong','','报告已保存'),node('span','',`命中 ${numeric(n.searchMatched??0)} 条 · ${numeric(n.selected??0)} 条正式记录`+(n.contextCount?' · '+numeric(n.contextCount)+' 条上下文':'')+' · 已请求浏览器打开'));if(e.warning)status.append(node('span','search-export-warning',e.warning));}
 function render(r){result=r;$('global-search-results').replaceChildren();const warning=r.state==='partial'?' · 结果暂不完整：部分来源无法读取，请检查提示后重试':'';note(status,r.state==='idle'?'尚未搜索':r.total?`${numeric(r.exactTotal)} 条精确 ID 命中${r.unidentified?' · '+numeric(r.unidentified)+' 条旧内容未能精确识别 ID，另计':''}${warning}`:'没有匹配结果'+warning);
  if(r.warnings?.length){const detail=node('details');detail.append(node('summary','','读取提示'));for(const w of r.warnings.slice(0,20))detail.append(node('p','field-hint',w));$('global-search-results').append(detail);}
  for(const row of r.rows){
   const card=node('article','search-hit'),heading=node('div','search-hit-heading'),identity=node('div','search-hit-author');
   card.dataset.searchKey=row.key;identity.append(node('strong','',row.author||'未知作者'));
   if(row.authorUid&&!new RegExp('^用户\\s*'+row.authorUid+'$').test(row.author||''))identity.append(node('span','search-hit-uid','UID '+row.authorUid));
   const time=node('time','search-hit-time',row.ms==null?'原始时间未知':dateText(row.ms));
   if(row.ms!=null)time.dateTime=new Date(row.ms).toISOString();heading.append(identity,time);card.append(heading);
   const badges=node('div','search-hit-badges');badges.append(node('span','search-hit-badge'+(row.contextOnly?' is-context':''),row.contextOnly?'引用上下文命中':row.type==='post'?'微博正文命中':'评论正文命中'));
   if(!row.id)badges.append(node('span','search-hit-badge is-context','ID 未确认'));
   if(row.versions>1)badges.append(node('span','search-hit-badge',row.versions+' 个保留版本'));card.append(badges);
   const body=node('p','search-hit-excerpt');body.append(highlight(excerpt(row.content,query().text),query().text));card.append(body);
   const post=node('div','search-hit-post');post.append(node('span','search-hit-post-label',row.postId?'所属博文 · '+row.postId:'所属会话未确认'));
   post.append(node('p','search-hit-post-text',row.postText||'暂无已保存的博文正文'));card.append(post);
   const byOwner=new Map();for(const source of row.sources){const old=byOwner.get(source.owner);if(!old||source.formal&&!old.formal)byOwner.set(source.owner,source);}
   const choices=[...byOwner.values()],select=node('select','search-hit-source-select');select.setAttribute('aria-label','选择保存来源');
   for(const source of choices){const opt=node('option','',sourceLabel(source));opt.value=source.owner;select.append(opt);}
   const footer=node('div','search-hit-footer'),sourceBox=node('div','search-hit-source');sourceBox.append(node('span','search-hit-source-label',choices.length>1?'打开来源':'保存于'));
   if(choices.length>1)sourceBox.append(select);else sourceBox.append(node('span','search-hit-source-name',choices.length?sourceLabel(choices[0]):'来源未确认'));
   const open=button('查看对话','button primary search-hit-open',()=>{openId=id();note(status,'正在生成会话报告…');send({action:'searchOpen',requestId:openId,snapshot:result.snapshot,key:row.key,owner:select.value});});open.disabled=!row.id||!row.usable&&!row.contextOnly||!choices.length;
   footer.append(sourceBox,open);card.append(footer);
   const details=node('details','search-hit-details'),associations=[...new Map(row.allSources.map(source=>[source.owner+'|'+source.channel+'|'+source.formal,source])).values()];
   details.append(node('summary','','记录信息'+(associations.length>1?' · '+associations.length+' 处保存关联':'')));
   const metadata=node('div','search-hit-metadata');metadata.append(node('p','',row.type==='post'?'微博 ID '+(row.id||'未确认'):'评论 ID '+(row.id||'未确认')));
   if(row.authorUid)metadata.append(node('p','','作者 UID '+row.authorUid));
   for(const source of associations){
    const line=node('p','',ownerText(source.owner,source.label)+' · ');
    if(source.trackedUid){
     const label=({sent:'相对该用户发出',received:'相对该用户收到'})[source.channel]||source.channel;
     line.append(markCommentDirection(node('span','',label),source.channel),' · ');
    }
    line.append(source.formal?'独立记录':'引用上下文');metadata.append(line);
   }
   if(row.contextOnly)metadata.append(node('p','','引用仅作为上下文，不计入独立正式记录。'));details.append(metadata);card.append(details);$('global-search-results').append(card);
  }
  const pages=$('global-search-pages');pages.replaceChildren();if(r.total>r.pageSize){const nav=delta=>{searchId=id();note(status,'正在读取本地结果…');send({action:'searchPage',requestId:searchId,snapshot:r.snapshot,page:r.page+delta});};const prev=button('上一页','button secondary',()=>nav(-1)),next=button('下一页','button secondary',()=>nav(1));prev.disabled=r.page===0;next.disabled=(r.page+1)*r.pageSize>=r.total;pages.append(prev,node('span','',`第 ${r.page+1} 页 · 每页 ${r.pageSize} 条`),next);}
 }
 function loadTimeline(){if(!ownerUid||!timeline.open)return;timelineId=id();note($('coverage-status'),'正在整理本地时间轴…');send({action:'coverageTimeline',requestId:timelineId,query:{uid:ownerUid,from:$('coverage-from').value,to:$('coverage-to').value}});}
 function enter(){const uid=state.view==='create'&&state.category==='users'?ReaderIdentity.user(state):'';timeline.hidden=!uid;if(uid!==ownerUid){if(timelineId)send({action:'insightsCancel',scope:'timeline'});ownerUid=uid;timelineId='';timeline.open=false;$('coverage-body').replaceChildren();$('coverage-from').value='';$('coverage-to').value='';window.ReaderDateControls?.refresh();note($('coverage-status'),'留空显示全部已保存时间。仅使用本地数据。');}}
 function renderTimeline(e) {
  const range=e.range||{};
  note($('coverage-status'),range.from||range.to?`当前日期：${range.from||'最早已保存时间'} — ${range.to||'最新已保存时间'} · 仅使用本地数据`:'全部已保存时间 · 可选择日期缩小范围，或点击下方日期带入');
  const root=$('coverage-body');root.replaceChildren();
  const missing=e.missingBodies;
  if(missing){
   const scope=node('p','field-hint coverage-missing-scope','缺正文 ID 按全部本地证据统计，不受所选日期影响。');
   if(missing.unconfirmed)scope.prepend(node('strong','',numeric(missing.unconfirmed)+' 个已知 ID 缺正文，方向未确认。 '));
   root.append(scope);
  }
  for(const d of e.directions) {
   const section=node('section','coverage-direction'),heading=node('div','coverage-direction-heading'),direction=d.kind==='sent'?'发出':'收到';
   heading.append(markCommentDirection(node('h3','',direction),d.kind),markCommentDirection(node('span','coverage-total',`已保存 ${numeric(d.records)} 条`),d.kind));section.append(heading);
   const metrics=node('div','coverage-metrics');
   const missingLabel=d.missingBodyCount?direction+'方向返回的已知 ID 缺正文':direction+'未发现已知缺正文 ID';
   for(const [count,label] of [[Object.values(d.days).reduce((n,v)=>n+v,0),'当前范围记录'],[d.missingBodyCount,missingLabel]]) {
    const metric=node('div');metric.append(node('strong','',numeric(count)),node('span','',label));metrics.append(metric);
   }
   section.append(metrics);
   if(d.unknownTime||d.unidentified)section.append(node('p','field-hint',(d.unknownTime?`${d.unknownTime} 条时间未知`:'')+(d.unknownTime&&d.unidentified?' · ':'')+(d.unidentified?`${d.unidentified} 条 ID 未确认，另计`:'')));
   const days=Object.keys(d.days).sort(),monthly=days.length&&Date.parse(days.at(-1))-Date.parse(days[0])>120*86400000,buckets={};
   for(const day of days){const key=monthly?day.slice(0,7):day;buckets[key]=(buckets[key]||0)+d.days[day];}
   section.append(node('h4','coverage-section-label',monthly?'已保存记录 · 按月':'已保存记录 · 按日'));
   const strip=node('div','coverage-distribution');strip.setAttribute('aria-label','已保存记录分布');
   for(const [day,count] of Object.entries(buckets)) {
    const b=button('','button secondary coverage-bin',()=>{
     const from=day.length===7?day+'-01':day,to=day.length===7?new Date(Date.UTC(Number(day.slice(0,4)),Number(day.slice(5)),0)).toISOString().slice(0,10):day;
     $('coverage-from').value=from;$('coverage-to').value=to;window.ReaderDateControls?.refresh();
     for(const item of root.querySelectorAll('.coverage-bin'))item.setAttribute('aria-pressed',String(item===b));
     note($('coverage-status'),`已选 ${from} — ${to}，点击“查看范围”应用筛选，或“导出此范围”生成 HTML。`);
    });
    b.append(node('span','',day),node('span','coverage-bin-count',`${count} 条`));b.setAttribute('aria-pressed','false');strip.append(b);
   }
   if(!days.length)strip.append(node('p','field-hint','此范围暂无已保存记录；不能据此判断没有互动。'));
   section.append(strip);
   const connected=d.events.filter(f=>f.type==='connected').length,targets=d.events.filter(f=>f.type==='target').length;
   const evidence=node('details','coverage-evidence');evidence.append(node('summary','','获取记录与说明'));
   const facts=node('p','field-hint',`${connected} 个已验证记录窗口 · ${targets} 次满足条数目标 · ${d.pending.length} 项待处理`);evidence.append(facts);
   if(d.unknown)section.append(node('p','coverage-unknown','覆盖情况未知：现有记录不足以判断该范围是否已取全。'));
   let shown=0;const more=button('继续显示获取记录','button secondary',appendFacts);
   function appendFacts() {
    const end=Math.min(shown+50,d.events.length);
    for(const fact of d.events.slice(shown,end)) {
     const item=node('p','coverage-fact',fact.label+(fact.count!=null?' · '+fact.count+(fact.budget!=null?' / '+fact.budget:'')+' 条':'')+(fact.missing?' · '+fact.missing+' 个已知 ID 缺少正文':'')+(fact.from&&typeof fact.from==='string'?' · '+fact.from+' — '+fact.to:''));
     item.append(node('span','field-hint',' · '+fact.detail));
     if(fact.lower||fact.upper)item.append(node('span','field-hint',` [记录边界 ${fact.lower||'未映射'} — ${fact.upper||'未知'}]`));evidence.append(item);
    }
    shown=end;more.remove();if(shown<d.events.length)evidence.append(more);
   }
   evidence.addEventListener('toggle',()=>{if(evidence.open&&!shown)appendFacts();});
   for(const warning of d.warnings||[]) {
    const text=/不能移植成功起点|请求链含缺失位置/.test(warning)?'部分历史请求含未返回的 ID，对应记录窗口暂不能确认连续。':warning;
    evidence.append(node('p','coverage-evidence-note',text));
   }
   section.append(evidence);
   for(const t of d.pending) {
    const task=node('details','coverage-task');task.append(node('summary','',t.interrupted?'查看中断任务':'查看待补区间'));
    task.append(node('p','field-hint','原任务 '+t.id+' · '+(t.scope?.from||t.scope?.to?`日期 ${t.scope.from||'未指定'} — ${t.scope.to||'未指定'}`:'固定的最近记录范围')+(t.scope?.limit!=null?' · 原上限 '+t.scope.limit:'')+(t.reason?' · '+t.reason:'')));
    for(const direction of t.directions||[]){
     const line=node('p','field-hint'),label=({sent:'发出',received:'收到'})[direction.kind]||direction.kind||'方向未确认';
     line.append(markCommentDirection(node('span','',label),direction.kind),' '+direction.covered+(direction.budget!=null?' / '+direction.budget:'')+' 条 · '+direction.reason);task.append(line);
    }
    if(t.resumable)task.append(button(t.interrupted?'继续原任务':'补齐区间','button secondary',()=>ReaderEntityActions.resumeTask(t.id)));section.append(task);
   }
   root.append(section);
  }
 }
 window.ReaderInsights={enter,receive(e){if(e.type==='library'){if(state.workspace!==window.ReaderInsightsWorkspace){window.ReaderInsightsWorkspace=state.workspace;searchId=timelineId=openId=objectId='';result=null;objects=[];$('global-search-results').replaceChildren();}enter();}if(e.type==='searchObjects'&&e.requestId===objectId){objects=e.objects;const s=$('global-search-owner');s.replaceChildren(node('option','','全部所属对象'));s.firstChild.value='';for(const o of objects){const p=node('option','',ownerText(o.key,o.note||o.label));p.value=o.key;s.append(p);}}
 if(e.type==='globalSearch'&&e.requestId===searchId)render(e);if(e.type==='insightsProgress'&&e.requestId===searchId)note(status,'索引准备中／搜索中… 已处理 '+(e.done??0)+' 个来源；完成前不显示为全部结果。');if(e.type==='insightsProgress'&&e.requestId===timelineId)note($('coverage-status'),'正在整理本地时间轴 · 已处理 '+(e.done??0)+' 个来源');if(e.type==='coverageTimeline'&&e.requestId===timelineId&&e.uid===ownerUid)renderTimeline(e);if(e.type==='searchOpened'&&e.requestId===openId)opened(e);if(e.type==='insightsError'){if(e.requestId===objectId)note(status,'所属对象筛选暂不可用：'+e.message,true);if(e.requestId===searchId||e.requestId===openId)note(status,e.cancelled?'搜索已取消':'搜索失败：'+e.message+(result?.rows?.length?' 下方保留上次已完成的本地结果，当前操作未完成。':''),!e.cancelled);if(e.requestId===timelineId)note($('coverage-status'),e.message,true);}}};
 $('global-search-entry').onclick=()=>{view('search');objectId=id();send({action:'searchObjects',requestId:objectId});$('global-search-text').focus();};$('global-search-back').onclick=()=>view('home');controls.addEventListener('submit',e=>{e.preventDefault();launch();});controls.addEventListener('input',schedule);controls.addEventListener('change',schedule);$('global-search-cancel').onclick=()=>{clearTimeout(timer);searchId='';send({action:'insightsCancel',scope:'search'});note(status,'搜索已取消。');};timeline.addEventListener('toggle',()=>{if(timeline.open)loadTimeline();else if(timelineId){timelineId='';send({action:'insightsCancel',scope:'timeline'});}});$('coverage-refresh').onclick=loadTimeline;
 $('coverage-export').onclick=()=>{if(!ownerUid||ReaderIdentity.user(state)!==ownerUid)return;const from=$('coverage-from').value,to=$('coverage-to').value;try{ReaderDates.bounds(from,to);}catch(error){toast(error.message,true);return;}setTask('report');$('view-range-enabled').checked=!!(from||to);$('from').value=from;$('to').value=to;$('unlimited').checked=true;updateForm();exportLocal();};
})();
