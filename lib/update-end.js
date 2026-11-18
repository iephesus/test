'use strict';
const {historyNext}=require('./history');
const {exactId}=require('./completeness');
function missingMetadata(raw,kind,{anchor='',cursor='',next}={}){
 const box=require('./core').rawArray(raw,kind)?.container||{};
 const values=box.miss_ids_str??box.miss_ids,reported=box.miss_count;
 const ids=new Set((Array.isArray(values)?values:[]).map(exactId).filter(id=>id&&(!anchor||BigInt(id)>BigInt(anchor))&&(!cursor||BigInt(id)<=BigInt(cursor))&&(!next||next==='0'||BigInt(id)>BigInt(next))));
 const validCount=reported==null||(typeof reported==='number'||typeof reported==='string'&&/^\d+$/.test(reported))&&Number.isSafeInteger(Number(reported))&&Number(reported)>=0;
 const invalid=!validCount||values!=null&&(!Array.isArray(values)||values.some(value=>!ids.has(exactId(value))));
 return {ids,uncertain:invalid||Number(reported)>ids.size};
}
// A nonempty zero is not a connected prefix. It is a candidate end that
// requires a small predecessor check unless an independent boundary is crossed.
function updateStep(raw,kind,anchor,cursor,ids,{knownIds=[]}={}){
 const next=historyNext(raw,kind),boundary=BigInt(anchor),low=ids.at(-1)||null;
 if(next&&next!=='0'&&(cursor&&BigInt(next)>=BigInt(cursor)||low&&BigInt(next)>BigInt(low)))throw Error('新增续取游标未推进或与正文矛盾');
 if(!ids.length&&next==='0'&&missingMetadata(raw,kind,{anchor,cursor,next}).uncertain)return {connected:false,next:cursor,verify:false,ambiguous:true,evidence:'empty-with-unknown-missing'};
 if(ids.some(id=>BigInt(id)<=boundary)||next&&next!=='0'&&BigInt(next)<=boundary)return {connected:true,next:null,verify:false,evidence:'crossed-anchor'};
 if(next==='0'&&!ids.length){
  const missing=missingMetadata(raw,kind,{anchor,cursor,next}).ids;
  if(knownIds.some(id=>BigInt(id)>boundary&&(!cursor||BigInt(id)<=BigInt(cursor))&&!missing.has(id)))return {connected:false,next:cursor,verify:true,ambiguous:true,evidence:'empty-conflicts-with-known'};
  return {connected:true,next:null,verify:false,evidence:'empty-terminal'};
 }
 if(next==='0'&&low){const continuation=(BigInt(low)-1n).toString();if(BigInt(continuation)<=boundary)return {connected:true,next:null,verify:false,evidence:'record-reaches-anchor-bound'};return {connected:false,next:continuation,verify:true,evidence:'nonempty-zero-placeholder'};}
 if(!ids.length&&next==null)return {connected:false,next:cursor,verify:false,ambiguous:true,evidence:'empty-without-cursor'};
 const continuation=next??(BigInt(low)-1n).toString();
 return {connected:BigInt(continuation)<=boundary,next:continuation,verify:false,evidence:next?'positive-continuation':'exclusive-record-bound'};
}
module.exports={updateStep,missingMetadata};
