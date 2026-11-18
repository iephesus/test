'use strict';
const {rawArray}=require('./core');
// A non-empty zero cursor can be a placeholder. Totals are hints, never
// deletion counts or a universal coverage denominator.
function createEndGuard(archive){
 let reportedTotal=null,checks=0;const missing=new Set();
 const smallest=ids=>ids.length?ids.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b):null;
 function inspect(raw,kind,ids,requestCount,knownCount,maxId=''){
  const box=rawArray(raw,kind)?.container||{},n=Number(box.total_number??box.total);
  if((box.total_number!=null||box.total!=null)&&Number.isSafeInteger(n)&&n>=0)reportedTotal=reportedTotal==null?n:Math.max(n,reportedTotal);
  const values=box.miss_ids_str??box.miss_ids;
  for(const id of Array.isArray(values)?values:[])if((typeof id!=='number'||Number.isSafeInteger(id))&&/^\d+$/.test(String(id))&&BigInt(id)>0n)missing.add(BigInt(id).toString());
  const rawMissing=Number(box.miss_count),missingCount=Number.isSafeInteger(rawMissing)&&rawMissing>=0?rawMissing:0,low=smallest(ids),boundary=low||maxId;
  const olderKnown=boundary?[...archive.records].some(([id])=>BigInt(id)<BigInt(boundary)):archive.records.size>0;
  const totalHint=reportedTotal!=null&&reportedTotal>knownCount+missing.size;
  return {low,olderKnown,totalHint,suspicious:olderKnown||totalHint||(ids.length>0&&ids.length+missingCount>=requestCount)};
 }
 return {inspect,check(){checks++;},get checks(){return checks;},get total(){return reportedTotal;},totalMismatch(knownCount){return reportedTotal!=null&&reportedTotal>knownCount+missing.size;}};
}
module.exports={createEndGuard};
