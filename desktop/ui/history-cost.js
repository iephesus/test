"use strict";
// Pure local accounting projection. Balance observations are never debits.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ReaderHistoryCost=api;})(typeof window==='object'?window:globalThis,()=>{
 const amount=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
 function summarize(records){
  const unique=new Map();for(const row of records){const key=row.autoRoundId||row.id;if(!key){unique.set(Symbol(),row);continue;}const score=r=>(Array.isArray(r.autoRequests)&&r.autoRequests.length?4:0)+(amount(r.billing?.estimatedCredits)!==null?2:0)+(r.billing?.verifiedLedger===true?1:0);if(!unique.has(key)||score(row)>score(unique.get(key)))unique.set(key,row);}
  const out={operations:unique.size,estimatedCredits:0,estimatedOperations:0,verifiedCredits:0,verifiedOperations:0,unknownRequests:0,unpricedOperations:0,reservedCredits:0};
  for(const row of unique.values()){
   const b=row.billing||{},requests=row.autoRequests||[];let estimate=amount(b.estimatedCredits),actual=b.verifiedLedger===true?amount(b.actualCredits):null;
   if(requests.length){const known=requests.map(q=>amount(q.estimatedCredits));estimate=known.every(n=>n!==null)?known.reduce((a,b)=>a+b,0):estimate;const actuals=requests.map(q=>q.verifiedLedger===true?amount(q.actualCredits):null);if(actuals.every(n=>n!==null))actual=actuals.reduce((a,b)=>a+b,0);out.unknownRequests+=Math.max(Number.isSafeInteger(b.unknownRequests)&&b.unknownRequests>0?b.unknownRequests:0,requests.filter(q=>q.status==='unknown'||q.status==='reserved').length);for(const q of requests)if(['unknown','reserved'].includes(q.status))out.reservedCredits+=amount(q.reservedCredits)||0;
   }else out.unknownRequests+=Number.isSafeInteger(b.unknownRequests)&&b.unknownRequests>0?b.unknownRequests:0;
   if(b.status==='no-content-requests')estimate=0;
   if(estimate!==null){out.estimatedCredits+=estimate;out.estimatedOperations++;}else out.unpricedOperations++;
   if(actual!==null){out.verifiedCredits+=actual;out.verifiedOperations++;}
  }
  for(const key of ['estimatedCredits','verifiedCredits','reservedCredits'])out[key]=Number(out[key].toFixed(6));return out;
 }
 return {summarize};
});
