'use strict';
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
const progressFields=['kind','covered','budget','cursor','pending','pendingNew','targetCovered','caughtUp','resumable','reason','stopCode'];
function taskSummary(summary){
 if(!summary)return summary;
 const projected=pick(summary,['incomplete','cancelled','records','addedRecords']);
 if(Array.isArray(summary.sources))projected.sources=summary.sources.map(source=>({
  ...pick(source,['kind','fetched','budget','failed','cancelled','reason','stopCode']),
  ...(source.readProgress?{readProgress:pick(source.readProgress,progressFields)}:{}),
  ...(source.dataStatus?{dataStatus:pick(source.dataStatus,['pendingNew','targetCovered','failed','coverageUnverified','missingBodies','unknownMissing','unknownTimeIds','progressConflict'])}:{}),
  ...(source.update?{update:{...pick(source.update,['pending','caughtUp']),...(source.update.protection?{protection:pick(source.update.protection,['latestSucceeded'])}:{})}}:{}),
  ...(source.autoStop?{autoStop:pick(source.autoStop,['code'])}:{})
 }));
 return projected;
}
function taskPresentation(task){
 const view=pick(task,['id','status','query','finishedAt','resumedBy','noticeDismissed','historicalContinuation','noticeToken','dismissToken','reason','failureCode']);
 if(task.summary)view.summary=taskSummary(task.summary);
 if(task.progressStatus){
  const p=task.progressStatus;
  view.progressStatus={...pick(p,['kind','resumable','targetCovered','dataState','missingBodyIds','canIgnoreGap']),...(Array.isArray(p.directions)?{directions:p.directions.map(direction=>pick(direction,progressFields))}:{})};
 }
 return view;
}
function userPresentation(user){
 const {historicalIssues,latestTask,pendingEvidence,directions,...view}=user;
 if(!view.pendingTasks?.length&&Array.isArray(pendingEvidence)&&pendingEvidence.length)
  view.pendingEvidence=pendingEvidence.map(item=>pick(item,['source','kind','taskId','token']));
 if(Array.isArray(view.pendingTasks))view.pendingTasks=view.pendingTasks.map(taskPresentation);
 return view;
}
function postPresentation(post){return Array.isArray(post.pendingTasks)?{...post,pendingTasks:post.pendingTasks.map(taskPresentation)}:post;}
// Homepage metadata is delivered before optional binary avatars. Each stream is
// bound to its workspace/snapshot; no profile or network query is performed.
function create({send,currentWorkspace,isClosing=()=>false,schedule=setImmediate}){
 let next=0;const versions=new Map();
 function prepare(type,data,base){
  if(!['homeUsers','postsHome'].includes(type))return data;
  const snapshotId=String(++next);versions.set(type,snapshotId);
  const input=type==='homeUsers'?data.users||[]:Object.values(data.authors||{});
  const wanted=input.filter(u=>/^\d{5,20}$/.test(u.uid||'')&&(u.avatarPending!==false||u.avatarData)).map(u=>({uid:u.uid,notice:u.profileNoticeId}));
  const strip=u=>({...u,avatarData:'',...(u.avatarData?{avatarPending:true}:{})});
  const result=type==='homeUsers'?{...data,avatarSnapshotId:snapshotId,users:input.map(u=>strip(userPresentation(u)))}:{...data,avatarSnapshotId:snapshotId,posts:(data.posts||[]).map(postPresentation),authors:Object.fromEntries(Object.entries(data.authors||{}).map(([id,u])=>[id,strip(u)]))};
  let at=0;
  function step(){
   if(isClosing()||currentWorkspace()!==base||versions.get(type)!==snapshotId)return;
   const entries=[];let bytes=0;
   const profiles=require('./user-profiles');
   while(at<wanted.length&&entries.length<12){const {uid,notice}=wanted[at++],p=profiles.cached(base,uid),profileNoticeId=profiles.noticeId(p);if(notice&&profileNoticeId!==notice)continue;const avatarData=p.avatarData||'';entries.push({uid,avatarData,profileNoticeId});bytes+=avatarData.length;if(bytes>=256*1024)break;}
   if(entries.length)send({type:'homeAvatars',workspace:base,snapshotType:type,snapshotId,entries});
   if(at<wanted.length)schedule(step);
  }
  if(wanted.length)schedule(step);return result;
 }
 return {prepare};
}
module.exports={create};
