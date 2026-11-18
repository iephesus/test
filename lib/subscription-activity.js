'use strict';
const {exactId}=require('./completeness');
const {completeBody}=require('./record-body');
// Counts and time must describe the same newly saved independent direction.
// This projection is scheduling input, never continuity or billing evidence.
function directionActivity(result,uid,firstSavedKeys=null){
 const kind=result.kind,rows=new Map();
 if(!['sent','received','post-comments'].includes(kind)||!exactId(uid))return {newIndependentCount:0,latestIndependentActivityMs:0};
 for(const row of result.activityRows||result.newRows||[]){
  const id=exactId(row.recordId),author=exactId(row.authorUid);
  if(!id||!author||row.isContext||row.group!==kind||!completeBody(row))continue;
  if(kind==='post-comments'?row.postId!==uid:kind==='sent'?author!==uid:author===uid)continue;
  if(firstSavedKeys&&!firstSavedKeys.has('comment:'+id))continue;
  rows.set(id,row);
 }
 return {newIndependentCount:rows.size,latestIndependentActivityMs:[...rows.values()].reduce((n,row)=>Number.isFinite(row.ms)?Math.max(n,row.ms):n,0)};
}
module.exports={directionActivity};
