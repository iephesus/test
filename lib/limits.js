'use strict';
// These are export/request budgets, not the API's per-response size limits.
function readLimit(value,flag){
 if(value==='all')return Infinity;
 const n=Number(value);
 if(!/^\d+$/.test(String(value).trim())||!Number.isSafeInteger(n)||n<1)throw Error(flag+' 必须是正的安全整数，或 all（不限）；--limit 与 --count 等价');
 return n;
}
function readPageSize(value,flag,maximum){
 const n=readLimit(value,flag);
 if(!Number.isFinite(n)||n>maximum)throw Error(flag+' 范围 1–'+maximum+'（接口单页上限，不限制总条数）');
 return n;
}
function assignCount(options,value,flag,state){
 const count=readLimit(value,flag);
 if(state.count!=null&&state.count!==count)throw Error('--all、--limit、--count 指定了冲突的总量，请只保留一个总量设置');
 state.count=count;options.count=count;
}
const limitLabel=value=>Number.isFinite(value)?String(value):'不限';
const sourceIncomplete=source=>require('./collection-result').collectionResult(source).incomplete;
module.exports={readLimit,readPageSize,assignCount,limitLabel,sourceIncomplete};
