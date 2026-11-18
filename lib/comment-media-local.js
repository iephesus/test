'use strict';
// Bounded, offline lookup for selected comments. An inventory is only a locator:
// every candidate is revalidated against its actual bytes and typed owner.
const fs=require('fs'),path=require('path'),C=require('./core'),M=require('./comment-media'),V=require('./file-view-cache'),S=require('./exchange-schema');
const channels=new Set(['sent','received','mentions-comments']);
function bounded(base,owner,file,namespace,maxBytes,project){
 const parentNames=[];for(let p=path.dirname(file);;p=path.dirname(p)){if(p!==base&&!p.startsWith(base+path.sep))throw Error('Media source outside workspace');parentNames.push(p);if(p===base)break;}
 const identity=s=>[s.dev,s.ino,s.mtimeNs,s.ctimeNs].join('/');
 const parents=()=>parentNames.map(p=>{const s=fs.lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw Error('Media source directory is not regular');return identity(s);}).join('|');
 const initial=parents(),before=V.regularStamp(file);if(!before||before.size>maxBytes||!fs.realpathSync(file).startsWith(owner+path.sep))throw Error('Media source path/size rejected');
 const validate=()=>{if(parents()!==initial||V.regularStamp(file)?.signature!==before.signature||!fs.realpathSync(file).startsWith(owner+path.sep))throw Error('Media source changed');};validate();
 const result=V.memo(namespace+'\0'+file,before.signature,()=>{
  let fd;try{
   const expected=fs.lstatSync(file,{bigint:true});fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const opened=fs.fstatSync(fd,{bigint:true});
   if(!opened.isFile()||opened.ino!==expected.ino||opened.dev!==expected.dev||Number(opened.size)>maxBytes)throw Error('Media source descriptor changed');validate();
   const chunks=[];let length=0;for(;;){const b=Buffer.allocUnsafe(Math.min(65536,maxBytes-length+1)),n=fs.readSync(fd,b,0,b.length,null);if(!n)break;length+=n;if(length>maxBytes)throw Error('Media source grew past bound');chunks.push(b.subarray(0,n));}
   if(identity(fs.fstatSync(fd,{bigint:true}))!==identity(opened))throw Error('Media bytes changed');validate();const bytes=Buffer.concat(chunks);return project(JSON.parse(bytes),{bytes,signature:before.signature,size:bytes.length});
  }finally{if(fd!=null)fs.closeSync(fd);}
 });validate();return result;
}
function create(base,{maxOwners=8,maxFiles=32,maxIndexes=128,maxIndexBytes=32*1024*1024,persist=false}={}){
 base=fs.realpathSync(base);const users=require('./storage').storagePaths(base).users,index=require('./storage').indexRead(users),visited=new Set(),owners=new Map(),stats={owners:0,indexes:0,indexBytes:0,indexMissing:0,sourceReads:0,candidates:0,matched:0,limited:false};
 function sources(uid,ids){
  if(!owners.has(uid)){
   if(!index[uid]||stats.indexes>=maxIndexes){if(index[uid])stats.limited=true;return [];}
   stats.indexes++;const dir=require('./storage').mappedFolder(users,uid,index),root=path.join(dir,'cache');
   if(!fs.existsSync(root)||!fs.realpathSync(root).startsWith(fs.realpathSync(users)+path.sep))return [];
   let locator=null;try{
    const file=path.join(root,'local-inventory-v1.json'),size=V.regularStamp(file)?.size||0;if(size>maxIndexBytes-stats.indexBytes)throw Error('Locator bound');stats.indexBytes+=size;
    locator=bounded(base,path.dirname(root),file,'comment-media-locator-v1:'+uid,maxIndexBytes,box=>{if(box.owner?.id!==uid||box.owner.category!=='user-comments')throw Error('Locator owner');const result={};for(const [relative,entry]of Object.entries(box.data?.files||{}))for(const kind of channels)for(const id of entry.contribution?.[kind]?.known||[])if(M.exact(id))(result[id]??=[]).push(relative);return result;});
   }catch{stats.indexMissing++;}
   owners.set(uid,{root,locator});
  }
  const {root,locator}=owners.get(uid),candidates=[];
  for(const id of ids)candidates.push(...(locator?.[id]||[]));
  // A missing/stale disposable index permits a small same-owner fallback only.
  // There is no startup scan or traversal of every user's raw archive.
  if(!candidates.length&&preferred.has(uid)&&fallbackOwners.size<maxOwners)try{fallbackOwners.add(uid);stats.owners=fallbackOwners.size;candidates.push(...fs.readdirSync(root).filter(n=>/^(?:sent|received|mentions-comments)_c\d+_m\d+(?:_s\d+)?(?:_legacy_[a-f0-9]{16})?\.json$/.test(n)).sort().slice(0,maxFiles));}catch{}
  const result=[];for(const relative of [...new Set(candidates)]){
   const role=require('./inventory-sources').sourceKind(relative,{category:'user-comments',id:uid});if(!channels.has(role)&&!['receipt','exchange'].includes(role))continue;
   if(relative.includes('..')||path.isAbsolute(relative)||relative.includes('\\'))continue;
   const file=path.resolve(root,relative);if(!file.startsWith(path.resolve(root)+path.sep))continue;
   result.push({file,role,uid,owner:path.dirname(root),relative:path.relative(base,file).split(path.sep).join('/')});
  }
  return result;
 }
 function project(source){
  return bounded(base,source.owner,source.file,'comment-media-source-v1',32*1024*1024,(box,meta)=>{
   stats.sourceReads++;if(meta.size>32*1024*1024)throw Error('Media source exceeds bound');
   let raw=box,bytes=meta.bytes;if(require('./exchange-store').isReference(box)){if(!Number.isSafeInteger(box.bytes)||box.bytes<1||box.bytes>32*1024*1024)throw Error('Shared media source exceeds bound');bytes=require('./exchange-records').bytes(source.file);if(bytes.length>32*1024*1024)throw Error('Shared media source exceeds bound');raw=JSON.parse(bytes);}
   const hash=S.hash(bytes),items=[];
   function packet(raw,kind){const parsed=C.rawArray(raw,kind);if(!parsed||C.apiError(raw))return;for(const value of parsed.items){if(kind==='sent'&&C.userId(value.user)!==source.uid)continue;for(const media of M.references(value))items.push({recordId:media.commentId,postId:media.postId,authorUid:media.authorUid,media});}}
   if(channels.has(source.role))packet(raw,source.role);
   else if(source.role==='receipt'&&raw.schema===1&&raw.query?.uid===source.uid&&channels.has(raw.query.kind))packet(raw.response,raw.query.kind);
   else if(source.role==='exchange'&&path.basename(source.file)===hash+'.json'&&raw.owner?.kind==='user'&&raw.owner.id===source.uid&&channels.has(raw.channel)){
    if(raw.role==='packet')packet(raw.response,raw.channel);
    else if(raw.role==='records')for(const row of raw.rows||[]){const media=M.normalize(row.commentMedia,row);if(media&&!row.isContext)items.push({recordId:row.recordId,postId:row.postId||'',authorUid:row.authorUid||'',media});}
   }
   return {hash,signature:meta.signature,items};
  });
 }
 function enrich(rows,postId){
  const eligible=rows.filter(r=>{if(r.isContext||!M.exact(r.recordId)||r.postId!==postId)return false;const media=M.normalize(r.commentMedia,r);return C.mergePostPictures(r.pictures).items.some(p=>M.pictureId(p.id)&&!media?.items.some(item=>item.pictureIds.includes(p.id)&&C.commentPictureViewer(item.url)));}),eligibleSet=new Set(eligible);
  if(!eligible.length)return {rows,changed:false,evidence:[],stats:{...stats}};
  const wanted=new Set(eligible.map(r=>r.recordId)),candidates=new Map();
  function inspect(source){
   if(visited.has(source.file))return;if(visited.size>=maxFiles){stats.limited=true;return;}visited.add(source.file);stats.candidates++;
   try{const value=project(source);for(const item of value.items){if(!candidates.has(item.recordId))candidates.set(item.recordId,[]);candidates.get(item.recordId).push({...item,evidence:{file:source.relative,hash:value.hash,signature:value.signature,ownerUid:source.uid}});}}catch{}
  }
  const locatorFile=path.join(require('./data-layout').readerRoot(base),'comment-media-locators',postId+'.json');
  let saved={};try{const box=bounded(base,base,locatorFile,'post-media-locators-v1',1024*1024,v=>v);if(box.schema===1&&box.postId===postId)saved=box.files||{};}catch{}
  for(const id of wanted)for(const ref of saved[id]||[]){
   const uid=M.exact(ref.uid);if(!index[uid]||typeof ref.file!=='string'||ref.file.includes('..')||path.isAbsolute(ref.file))continue;
   const owner=require('./storage').mappedFolder(users,uid,index),file=path.resolve(base,ref.file),relative=path.relative(path.join(owner,'cache'),file),role=require('./inventory-sources').sourceKind(relative,{category:'user-comments',id:uid});
   if(!relative.startsWith('..')&&(channels.has(role)||['receipt','exchange'].includes(role)))inspect({file,owner,uid,role,relative:ref.file});
  }
  const needLookup=eligible.some(row=>{const pids=C.mergePostPictures(row.pictures).items.map(p=>p.id).filter(Boolean);return pids.some(pid=>![...(candidates.get(row.recordId)||[]),...(known.get(row.recordId)||[])].some(s=>(!s.postId||s.postId===postId)&&(!s.authorUid||!row.authorUid||s.authorUid===row.authorUid)&&s.media.items.some(i=>i.pictureIds.includes(pid))));});
  for(const row of eligible)for(const uid of [row.authorUid,row.targetUid,row.postAuthorUid].map(M.exact).filter(Boolean))preferred.add(uid);
  const uids=[...new Set([...preferred,...Object.keys(index).filter(uid=>M.exact(uid))])];
  for(const uid of needLookup?uids:[])for(const source of sources(uid,wanted)){
   inspect(source);
  }
  // Older inventories count formal comments, not explicitly referenced image
  // objects. Give first-page received/sent packets a bounded, fair fallback.
  if([...wanted].some(id=>!candidates.has(id)&&!known.has(id))){
   for(const data of owners.values())try{data.first??=fs.readdirSync(data.root).filter(n=>/^(?:received|sent|mentions-comments)_c\d+_m0\.json$/.test(n)).sort((a,b)=>Number(!a.startsWith('received'))-Number(!b.startsWith('received'))||Number(a.match(/_c(\d+)/)[1])-Number(b.match(/_c(\d+)/)[1]));}catch{data.first=[];}
   for(let round=0;round<2;round++)for(const [uid,data]of owners){const relative=data.first?.[round];if(!relative)continue;const file=path.join(data.root,relative);inspect({file,owner:path.dirname(data.root),uid,role:relative.split('_')[0],relative:path.relative(base,file).split(path.sep).join('/')});}
  }
  // Keep lookup projections across pages of this operation, without reparsing.
  for(const [id,values]of candidates)known.set(id,[...(known.get(id)||[]),...values]);
  const evidence=[];let changed=false;
  const result=rows.map(row=>{
   if(!eligibleSet.has(row))return row;
   const pids=new Set(C.mergePostPictures(row.pictures).items.map(p=>p.id).filter(Boolean)),matches=[];
   for(const source of known.get(row.recordId)||[]){
    if(source.postId&&source.postId!==postId||source.authorUid&&row.authorUid&&source.authorUid!==row.authorUid)continue;
    try{const file=path.join(base,source.evidence.file),owner=require('./storage').mappedFolder(users,source.evidence.ownerUid,index);for(let p=path.dirname(file);p!==base;p=path.dirname(p)){if(!p.startsWith(base+path.sep)||fs.lstatSync(p).isSymbolicLink())throw Error('Media parent changed');}if(!fs.realpathSync(file).startsWith(path.resolve(owner)+path.sep)||V.regularStamp(file)?.signature!==source.evidence.signature)continue;}catch{continue;}
    for(const item of source.media.items)if(item.pictureIds.length&&item.pictureIds.some(id=>pids.has(id)))matches.push({item,source});
   }
   // Resolve each actual returned picture independently. Two pictures with two
   // valid viewers are not a conflict; two competing viewers for one picture are.
   const chosen=[],old=M.normalize(row.commentMedia,row);
   for(const pid of pids){
    const part=matches.filter(m=>m.item.pictureIds.includes(pid)),current=(old?.items||[]).filter(m=>m.pictureIds.includes(pid)),unified=M.normalize({schema:1,commentId:row.recordId,postId,authorUid:row.authorUid||'',items:[...part.map(m=>m.item),...current].map(item=>({...item,pictureIds:[pid]}))},row),addresses=new Set((unified?.items||[]).map(m=>{const u=new URL(m.url);return u.origin+u.pathname;})),authors=new Set([...part.map(m=>m.source.authorUid),...(current.length?[old.authorUid]:[])].filter(Boolean));
    if(addresses.size!==1||authors.size>1)continue;chosen.push(...part.map(m=>({...m,item:{...m.item,pictureIds:[pid]}})));
   }
   if(!chosen.length)return row;
   const allAuthors=new Set(chosen.map(m=>m.source.authorUid).filter(Boolean));if(allAuthors.size>1)return row;
   const media=M.normalize({schema:1,commentId:row.recordId,postId,authorUid:row.authorUid||[...allAuthors][0]||'',items:[...(old?.items||[]),...chosen.map(m=>m.item)]},row);if(!media||S.stable(media)===S.stable(old))return row;
   changed=true;stats.matched++;evidence.push({commentId:row.recordId,postId,pictureIds:[...pids].sort(),sources:chosen.map(m=>m.source.evidence),media});return {...row,commentMedia:media};
  });
  if(persist&&evidence.length){for(const item of evidence)saved[item.commentId]=[...new Map(item.sources.map(s=>[s.file,{uid:s.ownerUid,file:s.file}])).values()];const entries=Object.entries(saved).slice(-512);try{require('./update-progress').atomic(locatorFile,{schema:1,postId,files:Object.fromEntries(entries)});}catch{stats.limited=true;}}
  return {rows:result,changed,evidence,stats:{...stats}};
 }
 const known=new Map(),preferred=new Set(),fallbackOwners=new Set();return {enrich,stats};
}
module.exports={create};
