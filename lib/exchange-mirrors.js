'use strict';
// A mutable cache can be a byte-for-byte mirror of a durable received response.
// Only the original request + received-text hash + saved-response linkage can
// identify that observation. Equal text or normalized rows alone cannot.
const fs=require('node:fs'),path=require('node:path'),S=require('./exchange-schema'),regular=require('./regular-file');
function collect(dir,uid){
 const folder=path.join(dir,'cache/request-journal'),result=new Map();
 for(const file of regular.list(folder,/^[a-f0-9-]+\.response\.json$/))try{
  const box=JSON.parse(regular.read(file)),stem=path.basename(file).replace('.response.json',''),q=box.query;
  if(box.schema!==1||q?.uid!==uid||box.receivedFile!==stem+'.received.json'||!/^[a-f0-9]{64}$/.test(box.receivedHash||'')||!Number.isFinite(Date.parse(box.savedAt))||typeof box.cacheFile!=='string')continue;
  const bytes=regular.read(path.join(folder,box.receivedFile));if(S.hash(bytes)!==box.receivedHash)continue;
  const received=JSON.parse(bytes),request=JSON.parse(regular.read(path.join(folder,stem+'.request.json')));
  if(received.schema!==1||request.schema!==1||request.status!=='saved'||request.responseFile!==path.basename(file)||request.savedAt!==box.savedAt||received.savedAt!==box.savedAt||S.stable(request.query)!==S.stable(q)||S.stable(received.query)!==S.stable(q)||received.queryHash!==S.hash(JSON.stringify(received.query))||received.cacheFile!==box.cacheFile||typeof received.responseText!=='string'||S.hash(received.responseText)!==received.responseTextHash||S.stable(JSON.parse(received.responseText))!==S.stable(box.response))continue;
  const cache=path.resolve(dir,box.cacheFile);if(path.dirname(cache)!==path.resolve(dir,'cache')||S.hash(regular.read(cache))!==received.responseTextHash)continue;
  const prior=result.get(cache);if(!prior||Date.parse(prior.savedAt)<Date.parse(box.savedAt))result.set(cache,{query:q,savedAt:box.savedAt,responseHash:received.responseTextHash});
 }catch{/* Unproven mirrors remain independent portable observations. */}
 return result;
}
module.exports={collect};
