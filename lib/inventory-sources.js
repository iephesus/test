'use strict';
// Project saved content into ID-only contributions. This is not scan evidence.
const path=require('node:path'),crypto=require('node:crypto');
const core=require('./core'),{exactId}=require('./completeness'),{completeBody}=require('./record-body');
const comments=['sent','received','mentions-comments','mentions-posts'];
const kinds=owner=>owner.category==='post-comments'?['post-comments']:owner.category==='posts'?['user-posts']:comments;
function sourceKind(relative,owner){
 const [parent,name]=relative.includes('/')?relative.split('/'):[null,relative];
 if(parent==='request-journal'&&/^[a-f0-9-]+\.response\.json$/.test(name))return 'receipt';
 if(parent==='report-snapshots'&&owner.category==='user-comments'&&/^[a-f0-9]{64}\.json$/.test(name))return 'snapshot';
 if(parent==='exchange-v1'&&/^[a-f0-9]{64}\.json$/.test(name))return 'exchange';
 if(parent==='data-updates'&&owner.category==='user-comments'&&name.endsWith('.json'))return 'gap';
 if(parent)return '';
 for(const kind of kinds(owner)){
  if(kind==='user-posts'&&/^user-posts_.*\.json$/.test(name))return kind;
  const pattern=new RegExp('^'+kind+'_c\\d+_m\\d+(?:_s\\d+)?'+(kind==='post-comments'?'(?:_p\\d+)?':'')+'(?:_legacy_[a-f0-9]{16})?\\.json$');
  if(pattern.test(name)||name===kind+'_page1.json')return kind;
 }
 return '';
}
function project(relative,raw,owner,bytes,file){
 if(require('./exchange-store').isReference(raw)){if(!file)throw Error('共享来源缺少本地路径');bytes=require('./exchange-records').bytes(file);raw=JSON.parse(bytes);}
 const role=sourceKind(relative,owner),allowed=kinds(owner),sets={};
 const add=(kind,id,body=false)=>{id=exactId(id);if(!id||!allowed.includes(kind))return;const s=sets[kind]??={known:new Set(),bodies:new Set()};s.known.add(id);if(body)s.bodies.add(id);};
 function packet(value,kind){
  if(!allowed.includes(kind)||core.apiError(value))return;
  const parsed=core.rawArray(value,kind);if(!parsed)return;
  const missing=parsed.container.miss_ids_str??parsed.container.miss_ids;
  if(Array.isArray(missing))for(const id of missing)add(kind,id);
  if(kind==='post-comments'){
   const rows=require('./post-comments').postPageRows(value,owner.id).rows;
   for(const row of rows)if(!row.isContext)add(kind,row.recordId,completeBody(row));
   function visit(items){for(const c of items){if(!c||typeof c!=='object')continue;add(kind,c.idstr??c.id??c.mid);for(const k of ['comments','replies','children'])visit(Array.isArray(c[k])?c[k]:core.rawArray(c[k],kind)?.items||[]);}}
   visit(parsed.items);return;
  }
  for(const c of parsed.items){
   if(!c||typeof c!=='object'||kind==='sent'&&core.userId(c.user)!==owner.id||kind==='user-posts'&&core.userId(c.user)!==owner.id)continue;
   const id=exactId(c.idstr??c.id??c.mid);if(!id)continue;
   const row=kind==='user-posts'?require('./user-posts').normalizeUserPost(c):core.normalize(c,kind,owner.id);
   // Timeline rows use the same stored-record rule as the local post dataset.
   add(kind,id,kind==='user-posts'?Number.isFinite(row.ms):completeBody(row,c));
  }
 }
 if(role==='receipt'){
  if(raw.schema===1&&raw.query?.uid===owner.id)packet(raw.response,raw.query.kind);
 }else if(role==='gap'){
  if(raw.schema===1&&raw.uid===owner.id&&allowed.includes(raw.kind)&&Array.isArray(raw.gapIds))for(const id of raw.gapIds)add(raw.kind,id);
 }else if(role==='snapshot'){
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==path.basename(relative,'.json')||raw.schema!==1||raw.uid!==owner.id||!Array.isArray(raw.rows))return {};
  for(const row of raw.rows){
   if(row.isContext)continue;
   for(const kind of allowed){const sent=row.group==='sent'||['发出','发出的评论','发出/收到'].includes(row.type),received=row.group==='received'||['收到','收到的评论','发出/收到'].includes(row.type),matches=kind==='sent'?sent&&row.authorUid===owner.id:kind==='received'?received:row.group===kind;
    // A report snapshot contributes complete independent bodies, never quotes.
    if(matches&&completeBody(row))add(kind,row.recordId,true);
   }
  }
 }else if(role==='exchange'){
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==path.basename(relative,'.json'))throw Error('导入内容哈希损坏');
  const typed=owner.category==='post-comments'?'post':'user';
  if(raw.owner?.kind!==typed||raw.owner?.id!==owner.id||!allowed.includes(raw.channel)||!['packet','records'].includes(raw.role))return {};
  for(const row of require('./exchange-records').rowsOf(raw))if(!row.isContext)add(raw.channel,row.recordId,completeBody(row)&&!row.truncated);
  if(raw.role==='packet')packet(raw.response,raw.channel);
 }else if(role==='user-posts'){
  if(raw.query?.uid===owner.id&&raw.endpoint==='statuses user_timeline/other')packet(raw.response,role);
 }else if(role)packet(raw,role);
 return Object.fromEntries(Object.entries(sets).map(([kind,s])=>[kind,{known:[...s.known],bodies:[...s.bodies]}]));
}
module.exports={kinds,sourceKind,project};
