"use strict";
// Local bookkeeping resolves an immutable task's identity/range, not its wire
// command. Old subscription commands can contain flags no longer executable;
// recovery must not re-run command validation or turn them into a new request.
function taskData(base,query){
 const ux=require('./ui/form-utils'),post=query?.mode==='post-comments';
 const target=post?ux.postId(query?.target):ux.uid(query?.target);
 if(!target)throw Error('本地任务身份无法核实，原始恢复证据保留');
 if(query.subject&&(post?query.subject.kind!=='post'||query.subject.id!==target:query.subject.kind!=='user'||query.subject.uid!==target))throw Error('本地任务与已保存对象身份不一致');
 const args=[target,query.mode,'--database','--limit','1'];
 for(const name of ['from','to'])if(query[name])args.push('--'+name,String(query[name]));
 const o=require('../lib/options').options(args),s=require('../lib/storage'),p=s.storagePaths(base);
 const root=o.postId?p.postComments:o.mode==='user-posts'?p.posts:p.users;
 return {o,target:o.postId||o.uid,dir:o.postId?s.findPostFolder(root,o.postId):s.mappedFolder(root,o.uid,s.indexRead(root))};
}
module.exports={taskData};
