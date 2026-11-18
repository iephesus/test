'use strict';
// Foundation rejects lone UTF-16 surrogates even though JSON.stringify accepts
// and escapes them. Only repair display/IPC strings; never rewrite raw evidence.
function wireJSON(value){return JSON.stringify(value,(_key,item)=>typeof item==='string'?item.toWellFormed():item);}
const maxFrameBytes=4*1024*1024,partBytes=1024*1024,maxSnapshotBytes=64*partBytes;
const homeSections={homeUsers:'users',postsHome:'posts',libraryData:'reports',reportsUpdated:'reports',followState:'subscriptions'};
let snapshotSequence=0;
function sendNativeSnapshot(send,event,bootstrapId,documentEpoch){
 const section=Object.hasOwn(homeSections,event.type)&&homeSections[event.type];
 const history=event.type==='updateHistory';
 if(!section&&!history){send(event);return;}
 const json=wireJSON(event),size=Buffer.byteLength(json);
 if(size<=maxFrameBytes){send(event,json);return;}
 // The next trusted attachment reads current presentation in its own generation.
 if(!documentEpoch)return;
 const owner=history?{requestId:event.requestId,target:event.target,targetKind:event.targetKind,mode:event.mode}:{};
 const scope={workspace:event.workspace,bootstrapId,...owner};
 if(size>maxSnapshotBytes){
  const message='本地记录过大，暂时无法完整显示。';
  send(history?{type:'updateHistoryError',...scope,message}:{type:'libraryState',...scope,section,status:'error',snapshotFailed:true,message});return;
 }
 const bytes=Buffer.from(json),snapshotId=++snapshotSequence,count=Math.ceil(size/partBytes);
 for(let index=0;index<count;index++){
  const data=bytes.subarray(index*partBytes,(index+1)*partBytes).toString('base64');
  send({type:'presentationSnapshotPart',...scope,documentEpoch,snapshotType:event.type,snapshotId,index,count,size,data});
 }
}
module.exports={wireJSON,sendNativeSnapshot};
