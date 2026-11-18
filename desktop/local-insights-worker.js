'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {randomUUID}=require('node:crypto');
const controllers=new Map();
let result=null,chain=Promise.resolve();
function cancel(scope){
 for(const work of controllers.values())if(!scope||work.scope===scope)work.controller.abort();
 if(!scope||scope==='search')result=null;
}
parentPort.on('message',m=>{
 if(m.action==='cancel'){cancel(m.scope);return;}
 const scope=m.action==='timeline'?'timeline':'search';
 if(m.action==='search'||m.action==='timeline')cancel(scope);
 const controller=new AbortController();controllers.set(m.id,{scope,controller});
 chain=chain.catch(()=>{}).then(async()=>{
 const opts={signal:controller.signal,progress:progress=>parentPort.postMessage({id:m.id,progress})};try{controller.signal.throwIfAborted();let value;
 if(m.action==='search'){result=null;const found=await require('../lib/local-search').search(workerData.base,m.query,opts);controller.signal.throwIfAborted();result={...found,snapshot:randomUUID()};value=page(result,m.page);}
 else if(m.action==='page'){if(m.snapshot!==result?.snapshot)throw Error('搜索结果已变化，请重新搜索');require('../lib/local-search').assertSnapshot(workerData.base,result);value=page(result,m.page);}
 else if(m.action==='resolve'){if(m.snapshot!==result?.snapshot)throw Error('搜索结果已失效，请重新搜索');const search=require('../lib/local-search');try{value=await search.resolve(workerData.base,result,m.key,m.owner);}catch(error){if(error.code!=='LOCAL_SEARCH_STALE')throw error;value=await search.resolve(workerData.base,result,m.key,m.owner,{currentOwner:true});}}
 else if(m.action==='timeline')value=await require('../lib/coverage-timeline').build(workerData.base,m.query,opts);
 else throw Error('未知本地查询');controller.signal.throwIfAborted();if(Buffer.byteLength(JSON.stringify(value))>2*1024*1024)throw Error('单页来源关联或任务信息过多，请先限定所属对象，或缩小本地数据范围后重试；原数据未改变');parentPort.postMessage({id:m.id,value});
 }catch(e){parentPort.postMessage({id:m.id,error:controller.signal.aborted?'已取消':e.message,code:e.code,cancelled:controller.signal.aborted});}
 finally{controllers.delete(m.id);}
 });
});
function page(r,n=0){n=Number.isSafeInteger(n)&&n>=0?n:0;return {...r,tokens:undefined,page:n,pageSize:40,rows:r.rows.slice(n*40,(n+1)*40).map(row=>({...row,content:excerpt(row.content),postText:row.postText.slice(0,140),sources:row.sources.map(({file,...s})=>({...s,label:s.label.slice(0,200)})),allSources:row.allSources.map(({file,...s})=>({...s,label:s.label.slice(0,200)}))}))};}
function excerpt(s){const q=result?.queryText||'';const at=q?s.toLocaleLowerCase().indexOf(q):0;return (at>60?'…':'')+s.slice(Math.max(0,at-60),Math.max(0,at-60)+320)+(s.length>320?'…':'');}
