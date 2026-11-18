'use strict';
(function(root){
 const valid=value=>/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/.test(value||'')&&value.length<3*1024*1024;
 function snapshot(state,event){
  const type=event.type,previous=state.homeAssetSnapshots?.[type],same=previous?.workspace===event.workspace;
  state.homeAssetSnapshots={...state.homeAssetSnapshots,[type]:{id:event.avatarSnapshotId,workspace:event.workspace}};
  const old=type==='homeUsers'?new Map((same?state.homeUsers||[]:[]).map(u=>[u.uid,u])):new Map(Object.entries(same?state.postAuthors||{}:{}));
  const merge=u=>{const before=old.get(u.uid);return !u.avatarData&&u.avatarPending!==false&&before&&before.profileNoticeId===u.profileNoticeId?{...u,avatarData:before.avatarData||''}:u;};
  return type==='homeUsers'?{...event,users:(event.users||[]).map(merge)}:{...event,authors:Object.fromEntries(Object.entries(event.authors||{}).map(([id,u])=>[id,merge(u)]))};
 }
 function apply(state,event){
  const saved=state.homeAssetSnapshots?.[event.snapshotType];if(!saved||saved.id!==event.snapshotId||saved.workspace!==event.workspace||state.workspace!==event.workspace)return [];
  const changed=[];for(const p of event.entries||[]){if(!/^\d{5,20}$/.test(p.uid||''))continue;const target=event.snapshotType==='homeUsers'?state.homeUsers?.find(u=>u.uid===p.uid):state.postAuthors?.[p.uid];if(!target||target.profileNoticeId!==p.profileNoticeId)continue;target.avatarData=valid(p.avatarData)?p.avatarData:'';target.avatarPending=false;changed.push(p.uid);}return changed;
 }
 function createSnapshotReader(deliver){
  const partBytes=1024*1024,maxSize=64*partBytes,sections={homeUsers:'users',postsHome:'posts',libraryData:'reports',reportsUpdated:'reports',followState:'subscriptions'};
  const historyFields=['requestId','target','targetKind','mode'];
  let pending=null,timer,newest=0;
  function reset(){clearTimeout(timer);pending=null;}
  function fail(frame){
   reset();
   const scope={workspace:frame.workspace,bootstrapId:frame.bootstrapId},message='本地记录传输未完成，请重试读取。';
   if(frame.snapshotType==='updateHistory')deliver({type:'updateHistoryError',...scope,...Object.fromEntries(historyFields.map(key=>[key,frame[key]])),message});
   else deliver({type:'libraryState',...scope,section:sections[frame.snapshotType],status:'error',snapshotFailed:true,message});
  }
  function receive(frame){
   const {snapshotId,snapshotType,index,count,size,workspace,bootstrapId,data}=frame;
   const history=snapshotType==='updateHistory';
   if(!history&&!Object.hasOwn(sections,snapshotType)||!Number.isSafeInteger(snapshotId)||snapshotId<1||snapshotId<newest)return;
   if(snapshotId>newest){
    if(pending)fail(pending);
    newest=snapshotId;
    if(index!==0||!Number.isSafeInteger(size)||size<=4*partBytes||size>maxSize||count!==Math.ceil(size/partBytes)){fail(frame);return;}
    const owner=history?Object.fromEntries(historyFields.map(key=>[key,frame[key]])):{};
    pending={snapshotId,snapshotType,workspace,bootstrapId,...owner,size,count,next:0,bytes:new Uint8Array(size)};
   }
   if(!pending)return;
   const expected=Math.min(partBytes,size-index*partBytes);
   if(pending.snapshotType!==snapshotType||pending.workspace!==workspace||pending.bootstrapId!==bootstrapId||pending.count!==count||pending.size!==size||index!==pending.next||history&&historyFields.some(key=>frame[key]!==pending[key])||typeof data!=='string'||data.length!==4*Math.ceil(expected/3)){fail(pending);return;}
   let value;
   try{
    const decoded=atob(data);if(decoded.length!==expected)throw Error('Invalid snapshot part length');
    for(let i=0,offset=index*partBytes;i<decoded.length;i++)pending.bytes[offset+i]=decoded.charCodeAt(i);
    if(++pending.next<count){clearTimeout(timer);timer=setTimeout(()=>fail(pending),15000);return;}
    value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pending.bytes));
    if(value?.type!==snapshotType||value.workspace!==workspace||value.bootstrapId&&value.bootstrapId!==bootstrapId||history&&historyFields.some(key=>value[key]!==pending[key]))throw Error('Invalid snapshot owner');
   }catch{fail(frame);return;}
   reset();deliver({...value,bootstrapId});
  }
  return {receive,reset};
 }
 const api={snapshot,apply,valid,createSnapshotReader};if(typeof module==='object'&&module.exports)module.exports=api;else root.ReaderHomeAssets=api;
})(globalThis);
