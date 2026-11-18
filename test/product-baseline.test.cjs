'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createLocalView}=require('../desktop/local-view'),{createReportAccess}=require('../desktop/report-access'),library=require('../desktop/library'),inbox=require('../lib/follow-inbox');
const uid='1000000101',other='1234567890',peer='9876543210';
function fixture(fn){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-product-baseline-')),dir=path.join(base,'data/user-comments/目标'),postDir=path.join(base,'data/post-comments','原作者_'+uid),postsDir=path.join(base,'data/posts/目标');
 const save=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v));};
 save(path.join(base,'data/.layout-v2'),2);for(const category of ['user-comments','posts'])save(path.join(base,'data',category,'.account_names.json'),{[uid]:{folder:'目标',nickname:'目标'},[other]:{folder:'另一用户',nickname:'另一用户'}});
 const row=(id,hour,author=uid,reply='')=>({idstr:String(id),text:'独立正文 '+id,created_at:hour.includes('T')?hour:'2026-10-29T'+hour+':00:00+08:00',user:{idstr:author,screen_name:author===uid?'目标':'对方'},rootidstr:reply||String(id),reply_id:reply||undefined,reply_comment:reply?{idstr:reply,text:'前文 '+reply,created_at:'2026-10-28T09:00:00+08:00',user:{idstr:peer,screen_name:'对方'}}:undefined,status:{idstr:uid,text:'原微博',user:{idstr:peer,screen_name:'原作者'}}});
 const sent=[row(111,'16',uid,'80'),row(110,'14'),row(105,'2026-10-01T10:00:00+08:00')],received=[row(112,'17',peer),row(111,'16',uid,'80'),row(109,'13',peer),row(80,'2026-10-28T09:00:00+08:00',peer)];
 save(path.join(dir,'cache/sent_c100_m0.json'),{comments:sent});save(path.join(dir,'cache/received_c100_m0.json'),{comments:received});save(path.join(postDir,'cache/post-comments_c100_m0.json'),{comments:[row(501,'18',peer),row(500,'15',uid)],next_cursor:'0'});
 save(path.join(postsDir,'cache/user-posts_c100_m0.json'),{query:{uid},endpoint:'statuses user_timeline/other',response:{statuses:[{idstr:'700',text:'本人微博',created_at:'2026-10-29T12:00:00+08:00',user:{idstr:uid,screen_name:'目标'}}]}});
 save(inbox.file(base,uid),{schema:1,uid,items:Object.fromEntries(['112','111','110','109','80'].map(id=>[id,{id,readAt:null}]))});save(inbox.file(base,other),{schema:1,uid:other,items:{111:{id:'111',readAt:null}}});
 const rawFiles=[path.join(dir,'cache/sent_c100_m0.json'),path.join(dir,'cache/received_c100_m0.json'),path.join(postDir,'cache/post-comments_c100_m0.json'),path.join(postsDir,'cache/user-posts_c100_m0.json')],raw=rawFiles.map(f=>[f,fs.readFileSync(f)]);
 // Any accidental content/account/price command would hit this isolated shim,
 // never a real service; its marker also catches swallowed invocation failures.
 const marker=path.join(base,'unexpected-api'),cli=path.join(base,'forbidden-api.js'),old=process.env.WEIBO_DESKTOP_CLI;fs.writeFileSync(cli,"require('node:fs').writeFileSync("+JSON.stringify(marker)+",'called');process.exit(91);");process.env.WEIBO_DESKTOP_CLI=cli;
 const q={target:uid,mode:'comments-both',limit:'2',markUnread:true};
 try{return fn({base,dir,postDir,postsDir,row,save,sent,received,q,service:createLocalView(base),raw});}finally{if(old===undefined)delete process.env.WEIBO_DESKTOP_CLI;else process.env.WEIBO_DESKTOP_CLI=old;const invoked=fs.existsSync(marker);fs.rmSync(base,{recursive:true,force:true});assert.equal(invoked,false,'local workflow must never invoke a service command');}
}
const snapshot=(base,id)=>fs.readFileSync(path.join(base,'output',id),'utf8');
function payload(html){return JSON.parse(html.match(/<script type="application\/json" id="weibo-report-records">([\s\S]*?)<\/script>/)[1]);}
test('product baseline: local counts -> export/reuse -> failed browser dispatch -> successful retry marks exact formal IDs only',()=>fixture(({base,dir,q,service,raw})=>{
 const before=fs.readFileSync(inbox.file(base,uid)),otherBefore=fs.readFileSync(inbox.file(base,other)),prepared=service.prepare(q);assert.equal(prepared.summary.matched,6);assert.equal(prepared.summary.selected,2);assert.equal(prepared.summary.totalUnread,5);assert.equal(prepared.summary.unread,2);assert.deepEqual(prepared.jobs[0].rows.map(r=>r.recordId),['112','111']);assert.deepEqual([...prepared.jobs[0].rows[1].directions].sort(),['received','sent']);assert.equal(service.stats().renders,0,'counts must not render a hidden preview');assert.equal(fs.existsSync(path.join(base,'output')),false);
 const exported=service.exportCurrent(q,prepared.token),id=exported.files[0],html=snapshot(base,id),data=payload(html);assert.deepEqual(data.rows.map(r=>r.recordId),['112','111']);assert.ok(data.context.some(r=>r.recordId==='80'&&r.isContext));assert.deepEqual(fs.readFileSync(inbox.file(base,uid)),before,'export alone is not a read receipt');const restarted=createLocalView(base),reused=restarted.exportCurrent(q);assert.equal(reused.reused,true);assert.deepEqual(reused.files,[id]);assert.equal(restarted.stats().renders,0);
 const access=createReportAccess(base),failed=access.open(id);assert.ok(failed.unreadTicket);assert.equal(inbox.unreadIds(inbox.peek(base,uid)).size,5,'no success callback after failed native dispatch');const retry=access.open(id);assert.equal(access.opened(retry.unreadTicket).changed,2);assert.deepEqual([...inbox.unreadIds(inbox.peek(base,uid))].sort(),['109','110','80']);assert.equal(access.opened(retry.unreadTicket),null,'receipts are one-use');assert.deepEqual(fs.readFileSync(inbox.file(base,other)),otherBefore,'same record IDs in another identity remain unread');assert.equal(snapshot(base,id),html,'opening does not rewrite a modern report');for(const [file,bytes]of raw)assert.deepEqual(fs.readFileSync(file),bytes);
}));
test('product baseline: changed snapshot and export failures preserve prior reports, exact selection and unread state',()=>fixture(({base,dir,row,save,q,service})=>{
 const current=service.prepare(q),out=service.exportCurrent(q,current.token),existing=snapshot(base,out.files[0]),before=fs.readFileSync(inbox.file(base,uid));save(path.join(dir,'cache/sent_c1_m120.json'),{comments:[row(120,'19')]});assert.throws(()=>service.exportCurrent(q,current.token),/变化/);assert.deepEqual(fs.readFileSync(inbox.file(base,uid)),before);assert.equal(snapshot(base,out.files[0]),existing);
 const write=fs.writeFileSync;fs.writeFileSync=(file,...args)=>{if(String(file).endsWith('.html'))throw Error('模拟报告保存失败');return write(file,...args);};try{assert.throws(()=>service.exportCurrent({...q,limit:'3'}),/保存失败/);}finally{fs.writeFileSync=write;}assert.equal(snapshot(base,out.files[0]),existing);assert.deepEqual(fs.readFileSync(inbox.file(base,uid)),before);const retry=service.exportCurrent(q);assert.deepEqual(payload(snapshot(base,retry.files[0])).rows.map(r=>r.recordId),['120','112']);assert.deepEqual(fs.readFileSync(inbox.file(base,uid)),before);
}));
test('product baseline: user directions and posts share one report slot, identical-numbered independent post keeps its own slot',()=>fixture(({base,q,service,raw})=>{
 const initialUnread=fs.readFileSync(inbox.file(base,uid)),postQuery={target:uid,mode:'post-comments',limit:'1'};const firstPost=service.exportCurrent(postQuery);assert.equal(firstPost.summary.selected,1);const access=createReportAccess(base),ticket=access.open(firstPost.files[0]);assert.equal(ticket.unreadTicket,null,'an untracked post cannot consume the identical-numbered user receipt');assert.deepEqual(fs.readFileSync(inbox.file(base,uid)),initialUnread);access.handedOff(ticket.handoffTicket,false);
 const postExports=[firstPost.files[0]];for(const params of [{limit:'2'},{limit:'1',from:'2026-10-29',to:'2026-10-29'},{limit:'2',from:'2026-10-29',to:'2026-10-29'}]){const result=service.exportCurrent({...postQuery,...params});postExports.push(...result.files);library.cleanupOwnerReports(base,result.files);}
 const userExports=[];for(const params of [{mode:'comments-sent',limit:'1'},{mode:'comments-received',limit:'1'},{limit:'2'},{mode:'user-posts',from:'2026-10-29',to:'2026-10-29',limit:'1'}]){const result=service.exportCurrent({...q,...params});assert.equal(result.files.length,1);userExports.push(...result.files);library.cleanupOwnerReports(base,result.files);}
 const reports=library.listReports(base),userReports=reports.filter(r=>r.uid===uid&&r.category!=='post-comments'),postReports=reports.filter(r=>r.category==='post-comments'&&r.postId===uid);assert.equal(userReports.length,1);assert.equal(postReports.length,1);assert.ok(userReports.every(r=>userExports.slice(-1).includes(r.id)));assert.ok(postReports.every(r=>postExports.slice(-1).includes(r.id)));assert.ok(userReports.some(r=>r.category==='posts'));for(const [file,bytes]of raw)assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(fs.readFileSync(inbox.file(base,uid)),initialUnread);assert.equal(service.prepare({...q,unlimited:true}).summary.selected,6);
}));
test('product baseline: local date/limit changes never fetch and empty range does not manufacture a report or clear unread',()=>fixture(({base,q,service})=>{
 const before=fs.readFileSync(inbox.file(base,uid)),dated=service.prepare({...q,from:'2026-10-01',to:'2026-10-28',unlimited:true});assert.deepEqual(dated.jobs[0].rows.map(r=>r.recordId),['80','105']);assert.equal(dated.summary.selected,2);assert.equal(dated.summary.credits,0);const empty={...q,from:'2025-01-01',to:'2025-01-01'},stats=service.prepare(empty);assert.equal(stats.summary.matched,0);assert.equal(stats.summary.selected,0);assert.deepEqual(service.exportCurrent(empty,stats.token).files,[]);assert.equal(fs.existsSync(path.join(base,'output')),false);assert.deepEqual(fs.readFileSync(inbox.file(base,uid)),before);assert.equal(service.stats().renders,0);
}));

test('writing a check timestamp does not discard an unchanged local report selection',()=>fixture(({dir,save,q,service})=>{
 const original=service.prepare(q),stats=service.stats();
 save(path.join(dir,'cache/updates/sent.json'),{uid,kind:'sent',checkedAt:'2026-11-15T21:20:00Z'});
 assert.strictEqual(service.prepare(q),original);
 assert.deepEqual(service.stats(),stats);
}));

test('opening the unread selection includes older unread IDs outside the latest report',()=>fixture(({base,q,service})=>{
 inbox.markRead(base,uid,['112','111']);
 assert.equal(service.prepare(q).summary.unread,0);
 const unread={...q,unlimited:true,markUnread:false,unreadOnly:true};
 const prepared=service.prepare(unread);
 assert.deepEqual(prepared.jobs[0].rows.map(row=>row.recordId),['110','109','80']);
 const exported=service.exportCurrent(unread,prepared.token);
 const id=exported.files[0],html=snapshot(base,id);
 assert.match(html,/<h1>目标 · 未读评论<\/h1>/);
 assert(payload(html).rows.every(row=>row.isUnread));
 const access=createReportAccess(base),failed=access.open(id);
 access.handedOff(failed.handoffTicket,false);
 assert.equal(inbox.unreadIds(inbox.peek(base,uid)).size,3);
 const retry=access.open(id);
 assert.equal(access.handedOff(retry.handoffTicket,true).result.changed,3);
 assert.equal(inbox.unreadIds(inbox.peek(base,uid)).size,0);
 assert.deepEqual(service.exportCurrent(unread).files,[]);
}));

test('unread report includes only the closest 100 earlier records and acknowledges only its unread snapshot',()=>fixture(({base,dir,q,row,save,sent,service})=>{
 const history=Array.from({length:105},(_,i)=>row(5000+i,new Date(Date.UTC(2026,8,30-i)).toISOString()));
 save(path.join(dir,'cache/sent_c100_m0.json'),{comments:[...sent,...history.reverse()]});
 inbox.markRead(base,uid,['112','110','80']);
 const query={...q,unlimited:true,unreadOnly:true,unreadContext:true};
 const prepared=service.prepare(query);
 const id=service.exportCurrent(query,prepared.token).files[0];
 const html=snapshot(base,id),data=payload(html);
 assert.equal(data.unreadContext,true);
 assert.match(html.match(/<header class="report-header">.*?<\/header>/)?.[0]||'',/2 条未读 · 100 条前文/);
 assert.deepEqual(data.rows.map(r=>r.recordId),['111','109','80','105',...Array.from({length:98},(_,i)=>String(5000+i))]);
 assert.deepEqual(data.rows.filter(r=>r.isUnread).map(r=>r.recordId),['111','109']);
 assert.throws(()=>service.exportCurrent({...query,unreadContext:false},prepared.token,null,{retainedSnapshot:true}),/其他范围/);
 assert.equal(service.exportCurrent(query).reused,true);

 const access=createReportAccess(base),failed=access.open(id);
 access.handedOff(failed.handoffTicket,false);
 assert.deepEqual([...inbox.unreadIds(inbox.peek(base,uid))].sort(),['109','111']);
 const opened=access.open(id),state=inbox.peek(base,uid);
 state.items['80'].readAt=null;
 save(inbox.file(base,uid),state);
 assert.equal(access.handedOff(opened.handoffTicket,true).result.changed,2);
 assert.deepEqual([...inbox.unreadIds(inbox.peek(base,uid))],['80']);
 inbox.markRead(base,uid,['80']);
 assert.deepEqual(service.exportCurrent(query).files,[]);
}));

test('independent post unread selection applies the limit after filtering and refreshes on the exact browser receipt',()=>fixture(({base,save,service})=>{
 const reading=require('../lib/post-reading-state'),before=fs.readFileSync(inbox.file(base,uid));
 save(reading.file(base,uid),{schema:2,postId:uid,items:{501:{id:'501',readAt:'2026-10-30T00:00:00Z'},500:{id:'500',readAt:null}},receipts:{}});
 const recent={target:uid,mode:'post-comments',limit:'1'};
 assert.deepEqual(service.prepare(recent).jobs[0].rows.map(row=>row.recordId),['501']);
 const unread={...recent,unreadOnly:true};
 const selected=service.prepare(unread);
 assert.deepEqual(selected.jobs[0].rows.map(row=>row.recordId),['500']);
 assert.equal(selected.summary.matched,1);
 const report=service.exportCurrent(unread,selected.token).files[0],access=createReportAccess(base);
 const dispatch=access.open(report);
 assert.equal(reading.unreadSummary(base,uid).unread,1);
 assert.equal(access.handedOff(dispatch.handoffTicket,true).result.changed,1);
 assert.equal(service.prepare(unread).summary.matched,0);
 assert.deepEqual(service.exportCurrent(unread).files,[]);
 assert.deepEqual(fs.readFileSync(inbox.file(base,uid)),before);
}));

test('report reuse considers the current typed owner and its newest valid HTML across both user categories',()=>fixture(({base,save})=>{
 const crypto=require('node:crypto'),catalog=require('../lib/report-catalog'),sameKey='same-content-key';
 const create=(id,when,localKey,metadata={uid})=>{
  const file=path.join(base,'output',id),html=Buffer.from('匿名报告 '+id);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,html);fs.utimesSync(file,when,when);
  return {...metadata,localKey,localHash:crypto.createHash('sha256').update(html).digest('hex')};
 };
 const selected='user-comments/目标/互动.html',newer='posts/目标/微博.html',post='post-comments/原作者_'+uid+'/评论.html',otherFile='user-comments/其他/互动.html';
 const entries={[selected]:create(selected,1000,sameKey),[newer]:create(newer,2000,'different'),[post]:create(post,3000,sameKey,{postId:uid}),[otherFile]:create(otherFile,4000,sameKey,{uid:other})};
 save(path.join(base,'data/.reader/report-catalog.json'),{schema:1,entries});
 assert.equal(catalog.reusable(base,sameKey,{uid,mode:'both'}),'','newer user posts exclude an older interaction report');
 assert.equal(catalog.reusable(base,sameKey,{postId:uid,mode:'post-comments'}),post);
 fs.unlinkSync(path.join(base,'output',newer));
 assert.equal(catalog.reusable(base,sameKey,{uid,mode:'both'}),selected,'missing newer file cannot hide the surviving exact owner');
 fs.appendFileSync(path.join(base,'output',selected),'用户编辑');
 assert.equal(catalog.reusable(base,sameKey,{uid,mode:'both'}),'','edited report never falls through to another owner');
}));
