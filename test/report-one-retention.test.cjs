'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),R=require('../lib/reader'),C=require('../lib/report-catalog'),L=require('../desktop/library');
const uid='1234567890',post='90071992547409931',peer='9876543210',save=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof v==='string'?v:JSON.stringify(v));};
function row(id,group='sent'){return {group,recordId:id,postId:post,authorUid:group==='sent'?uid:peer,author:'合成作者',content:'可靠完整正文 '+id,ms:1793246400000,time:'2026-10-29 12:00:00',type:group==='sent'?'发出':'收到',rootId:id};}
async function fixture(fn,{hashRegistered=false}={}){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'reader-report-one-')),dir=path.join(base,'data/user-comments',uid),folder=path.join(base,'output/user-comments',uid),files=[];
 save(path.join(base,'data/.layout-v2'),'2');
 save(path.join(base,'data/user-comments/.account_names.json'),{[uid]:{folder:uid,nickname:'合成用户'}});
 for(let i=0;i<3;i++){
  const rows=[row(String(101+i))],file=path.join(folder,i+'.html'),html=R.render({uid,mode:'sent'},rows,[],'合成用户');
  save(file,html);fs.utimesSync(file,new Date(1000+i*1000),new Date(1000+i*1000));
  C.save(file,{uid,workspace:base,mode:'sent',...(hashRegistered?{localHash:crypto.createHash('sha256').update(html).digest('hex')}:{})},rows,'合成用户');
  files.push(file);
 }
 fs.rmSync(path.join(dir,'cache/report-snapshots'),{recursive:true,force:true});
 try{return await fn({base,dir,folder,files});}finally{C.pauseMaintenance(base);fs.rmSync(base,{recursive:true,force:true});}
}
for(const fault of ['write','sync','readback'])test('HTML-only bodies survive '+fault+' failure before cleanup and are reliably regenerated after retry',()=>fixture(({base,dir,files})=>{const store=require('../lib/durable-write'),old=store.atomicBytes,sync=fs.fsyncSync,read=require('../lib/regular-file').read;try{if(fault==='write')store.atomicBytes=()=>{throw Error('simulated write failure');};if(fault==='sync')fs.fsyncSync=()=>{throw Error('simulated fsync failure');};if(fault==='readback')require('../lib/regular-file').read=function(f,...a){const b=read(f,...a);return String(f).includes('report-snapshots')?Buffer.from('changed'):b;};const result=L.cleanupOwnerReports(base);assert.equal(result.removed,0);assert(files.every(f=>fs.existsSync(f)));}finally{store.atomicBytes=old;fs.fsyncSync=sync;require('../lib/regular-file').read=read;}assert.equal(L.cleanupOwnerReports(base).removed,2);assert(fs.existsSync(files[2]));const archive=require('../lib/completeness').loadIndependentArchive(dir,'sent',uid);assert.equal(archive.records.get('101')?.row.content,row('101').content);assert.equal(archive.records.get('102')?.row.content,row('102').content);}));
test('startup maintenance reduces existing reports to one and preserves the newest while an older native handoff is pinned',()=>fixture(async({base,files})=>{const pin=require('../lib/report-lifecycle').pin(base,C.idOf(base,files[0]));C.resumeMaintenance(base);C.maintainPending(base);assert(fs.existsSync(files[0]));assert(fs.existsSync(files[2]));assert(!fs.existsSync(files[1]));pin.release();C.maintainPending(base);assert.deepEqual(L.listReports(base).map(r=>r.id),[C.idOf(base,files[2])]);}));
test('report IDs normalize Windows backslashes so open/pin do not reject them',()=>fixture(({base,files})=>{
 const slash=C.idOf(base,files[0]),win=slash.replace(/\//g,'\\');
 assert.match(slash,/\//);
 assert.equal(C.normalizeId(win),slash);
 assert.equal(C.contained(base,win),path.resolve(path.join(base,'output'),slash));
 assert.equal(L.containedReport(base,win),fs.realpathSync(path.join(base,'output',...slash.split('/'))));
 const pin=require('../lib/report-lifecycle').pin(base,win);
 assert.equal(pin.id,win);pin.release();
}));
test('startup maintenance preserves a registered report with an edited appendix and removes an intact older report',()=>fixture(({base,dir,files})=>{
 const [edited,intact,newest]=files,original=fs.readFileSync(edited,'utf8');
 const changed=original.replace('</body>','<aside>手写附录</aside></body>');
 const {reportPayload}=require('../lib/report-records');
 assert.notEqual(changed,original);
 assert.deepEqual(reportPayload(changed,uid),reportPayload(original,uid));
 fs.writeFileSync(edited,changed);
 C.resumeMaintenance(base);
 assert.deepEqual(C.maintainPending(base),{removed:1,skipped:1});
 assert.equal(fs.readFileSync(edited,'utf8'),changed);
 assert.equal(fs.existsSync(intact),false);
 assert.equal(fs.existsSync(newest),true);
 const archive=require('../lib/completeness').loadIndependentArchive(dir,'sent',uid);
 assert.equal(archive.records.get('102')?.row.content,row('102').content);
},{hashRegistered:true}));
for(const reversed of [false,true])test('mixed typed post/comment IDs never redirect a real reply, including lazy rendering: '+reversed,()=>{const comment=row(post,'received'),mentioned={...row(post,'mentions-posts'),postId:post,postAuthorUid:'1111111111',authorUid:'1111111111',postAuthor:'微博作者',author:'微博作者',content:'微博正文',postText:'微博正文'},child={...row('201'),postId:post,replyId:post,rootId:'',ms:1793246460000};let rows=[comment,mentioned,child];if(reversed)rows=[mentioned,comment,child];const attributed=R.attributeRows(rows,uid),reply=attributed.find(r=>r.recordId==='201');assert.equal(reply.replyAuthorUid,peer);assert.equal(reply.replyText,comment.content);for(const count of [3,210]){const input=count===3?rows:[...rows,...Array.from({length:207},(_,i)=>({...row(String(300+i)),postId:String(8000000000+i)}))],html=R.render({uid,mode:'all',lazyConversations:true},input,[],'合成用户');assert(html.includes('data-standalone-post'));assert(html.includes('微博正文'));const payload=require('../lib/report-records').reportPayload(html,uid);assert.equal(payload.rows.length,count);assert.equal(new Set(payload.rows.map(require('../lib/records').recordKey)).size,count);assert.equal(payload.rows.find(r=>r.recordId==='201').replyAuthorUid,peer);}});
