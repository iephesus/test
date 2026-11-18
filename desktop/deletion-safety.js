'use strict';
// Validate every destructive transaction path before moving its first owner.
const fs=require('node:fs'),path=require('node:path'),access=require('../lib/workspace-access'),regular=require('../lib/regular-file'),{readerRoot}=require('../lib/data-layout');
const invalid=cause=>Object.assign(Error('删除事务路径或恢复证据无法安全核实；未移动正文，原文件保留',{cause}),{code:'LOCAL_SOURCE_INVALID'});
function directory(base,file,create=false){try{return access.directory(base,path.relative(base,file),{create});}catch(e){throw invalid(e);}}
function read(file,fallback){try{return JSON.parse(regular.read(file,{maxBytes:16*1024*1024}));}catch(e){if(e.code==='ENOENT')return fallback;throw invalid(e);}}
function preflight(base,jobs=[]){
 try{
  const root=readerRoot(base);
  for(const top of ['data','output'])for(const category of ['user-comments','post-comments','posts']){const folder=directory(base,path.join(base,top,category));read(path.join(folder,'.account_names.json'),null);}
  for(const name of ['deleting','deletion-jobs','bulk-deletion-jobs','auto-follow','auto-follow/rounds','manual-tasks','task-finalization','merges','profiles'])directory(base,path.join(root,name));
  for(const name of ['users.json','posts.json','preferences.json','database-status.json','report-catalog.json','auto-follow/settings.json'])read(path.join(root,name),null);
  for(const name of ['deletion-jobs','bulk-deletion-jobs','manual-tasks','task-finalization','auto-follow/rounds']){
   const folder=path.join(root,name);if(!fs.existsSync(folder))continue;for(const file of regular.list(folder,/\.json(?:\.stop)?$/))read(file,null);
  }
  for(const job of jobs){
   if(!/^[a-f0-9-]{36}$/.test(job.id||'')||!/^\d{5,20}$/.test(job.uid||'')||!Array.isArray(job.paths))throw Error('删除任务身份无效');
   const stage=directory(base,path.join(root,'deleting',job.id));
   for(const [i,relative]of job.paths.entries()){
    if(typeof relative!=='string'||! /^(?:data|output)\/(?:user-comments|posts|post-comments)\/[^/]+$/.test(relative)&&relative!==path.relative(base,path.join(root,'profiles',job.uid)))throw Error('删除任务目录类型无效');
    const source=directory(base,path.resolve(base,relative)),target=directory(base,path.join(stage,String(i)));
    if(fs.existsSync(source)&&fs.existsSync(target))throw Error('正文与暂存位置同时存在，需核对原事务');
   }
  }
 }catch(e){throw e.code==='LOCAL_SOURCE_INVALID'?e:invalid(e);}
}
module.exports={directory,read,preflight};
