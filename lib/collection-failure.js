'use strict';
// Request accounting is separate from validated formal bodies and progress.
// A returned, durably saved response may fail a later local validation step.
function accountFailure(out,error={}){
 const apiCalls=error.apiAttempt===true?1:0,cachedCalls=!apiCalls&&error.cached===true?1:0;
 const received=error.responseReceived===true,saved=error.responseSaved===true;
 const countKnown=Number.isSafeInteger(error.returnedRecords)&&error.returnedRecords>=0;
 const returnedRecords=apiCalls&&received&&saved&&countKnown?error.returnedRecords:0;
 const billingUnknown=apiCalls?!(received&&saved&&countKnown&&error.billingUnknown===false):error.billingUnknown===true;
 if(apiCalls||cachedCalls){out.requests=(out.requests||0)+apiCalls+cachedCalls;out.cachedCalls=(out.cachedCalls||0)+cachedCalls;out.newFetched=(out.newFetched||0)+returnedRecords;out.billingUnknown=!!out.billingUnknown||billingUnknown;}
 const serviceRejection=saved&&require('./service-rejection').publicValue(error.serviceRejection);
 if(apiCalls||cachedCalls||received)out.requestFailure={apiAttempt:!!apiCalls,cached:!!cachedCalls,responseReceived:received,responseSaved:saved,returnedRecords,billingUnknown,code:typeof error.code==='string'?error.code:null,...(serviceRejection?{serviceRejection}:{})};
 return {apiCalls,cachedCalls,returnedRecords};
}
module.exports={accountFailure};
