'use strict';
// Disposable, resumable LOCAL statistics work. Original task failures stay in
// their own audit; this status never certifies content or pagination progress.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const folder=base=>path.join(require('./data-layout').readerRoot(base),'inventory-repairs');
function file(base,owner){if(!['user-comments','post-comments','posts'].includes(owner?.category)||!/^\d{5,20}$/.test(owner?.id||''))throw Error('本地统计修复身份无效');return path.join(folder(base),owner.category+'.'+owner.id+'.json');}
function read(base,owner){try{const v=JSON.parse(fs.readFileSync(file(base,owner)));if(v.schema!==1||v.owner?.id!==owner.id||v.owner?.category!==owner.category||!['queued','running','complete','failed'].includes(v.state))throw Error('本地统计修复记录损坏');return v;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function save(base,value){require('./update-progress').atomic(file(base,value.owner),value);return value;}
function queue(base,owner,taskId,diagnostic){const old=read(base,owner),tasks=[...new Set([...(old?.taskIds||[]),taskId].filter(x=>typeof x==='string'))].slice(-64);return save(base,{schema:1,id:crypto.randomUUID(),owner,taskIds:tasks,state:'queued',queuedAt:new Date().toISOString(),attempts:0,diagnostic:diagnostic||null});}
function list(base){const dir=folder(base);if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>/^(?:user-comments|post-comments|posts)\.\d{5,20}\.json$/.test(n)).map(n=>{const [category,id]=n.split('.');return read(base,{category,id});});}
module.exports={file,read,save,queue,list};
