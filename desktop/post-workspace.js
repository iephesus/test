'use strict';
const path=require('node:path');const {readerRoot}=require('../lib/data-layout'),{atomic}=require('../lib/update-progress'),{storagePaths}=require('../lib/storage');
const metadata=require('../lib/post-metadata');
function add(base,target){const postId=require('../lib/options').options([String(target),'post-comments','--dry-run']).postId,box=metadata.readRegistry(base);box.posts[postId]={...box.posts[postId],postId,title:box.posts[postId]?.title||'微博 '+postId,lastViewedAt:new Date().toISOString()};atomic(metadata.registryFile(base),box);return postId;}
function list(base){
 const posts=metadata.listMetadata(base),updates=new Map();
 for(const entry of require('../lib/database-sync').statuses(base)){
  if(entry.category==='post-comments'&&entry.updatedAt>(updates.get(entry.target)||''))updates.set(entry.target,entry.updatedAt);
 }
 const tasksByPost=new Map(),{postId}=require('./ui/form-utils');
 const pending=task=>task.status==='running'||['interrupted','partial','failed'].includes(task.status)&&!task.resumedBy&&task.progressStatus?.resumable!==false;
 for(const task of require('./user-workspace').tasks(base)){
  if(task.query.mode!=='post-comments'||task.query.source&&task.query.source!=='cli'||!pending(task))continue;
  const id=postId(task.query.target),tasks=tasksByPost.get(id);
  if(tasks)tasks.push(task);else tasksByPost.set(id,[task]);
 }
 return posts.map(({post})=>{
  const updatedAt=updates.get(post.postId)||null;
  const reading=require('../lib/post-reading-state').unreadSummary(base,post.postId);
  const tasks=tasksByPost.get(post.postId);
  return {...post,updatedAt,unread:reading.unread,unreadUnavailable:!!reading.unavailable,note:typeof post.note==='string'?post.note:'',pendingTasks:tasks??[]};
 }).sort((a,b)=>String(b.lastViewedAt||b.updatedAt||'').localeCompare(String(a.lastViewedAt||a.updatedAt||'')));
}
function favorite(base,id,on){if(!/^\d{5,20}$/.test(id))throw Error('微博 ID 无效');const f=path.join(readerRoot(base),'preferences.json'),p=require('./library').preferences(base);if(on)add(base,id);p.postFavorites=(p.postFavorites||[]).filter(v=>v!==id);if(on)p.postFavorites.unshift(id);atomic(f,p);return p;}
function author(base,postId){
 if(typeof postId!=='string'||!/^[1-9]\d{4,19}$/.test(postId))throw Error('微博 ID 无效');
 const dir=require('../lib/storage').findPostFolder(storagePaths(base).postComments,postId),user=metadata.read(dir,postId).source.user;
 const uid=user?.idstr||'';
 return /^[1-9]\d{4,19}$/.test(uid)?{dir,uid,nickname:user.screen_name}:null;
}
// Publish each author's cached image once, even when many saved posts share it.
function authors(base,posts,{avatars=true}={}){
 const result={},profiles=require('./user-profiles');
 for(const post of posts){
  const uid=post.authorUid;if(!/^\d{5,20}$/.test(uid||'')||result[uid])continue;
  const profile=profiles.cached(base,uid,{avatar:avatars});
  result[uid]={uid,nickname:profile.nickname||post.author||'',profileNoticeId:profiles.noticeId(profile),avatarData:profile.avatarData||'',avatarPending:!avatars&&!!profile.avatarFile};
 }
 return result;
}
module.exports={add,list,favorite,author,authors};
