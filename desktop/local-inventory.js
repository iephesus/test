'use strict';
// The desktop adapts identity only. Persistent statistics are shared with the
// acquisition finalizer and can always be rebuilt from local content files.
const storage=require('../lib/storage');
function query(input={}){return {target:String(input.target||''),mode:input.mode,unlimited:true};}
function locate(base,input){
 const o=require('./local-view').validate(query(input)),p=storage.storagePaths(base),post=o.mode==='post-comments',posts=o.mode==='user-posts',id=o.postId||o.uid,category=post?'post-comments':posts?'posts':'user-comments',root=post?p.postComments:posts?p.posts:p.users;
 const dir=post?storage.findPostFolder(root,id):storage.mappedFolder(root,id,storage.indexRead(root));
 return {dir,owner:{id,category},kind:o.mode};
}
function inventory(base,input){const {dir,owner,kind}=locate(base,input);return require('../lib/inventory-index').inventory(dir,owner,kind);}
module.exports={inventory,query,locate};
