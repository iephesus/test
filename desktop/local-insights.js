'use strict';
// One bounded, disposable local worker. No network client, scheduler or renderer.
const {Worker}=require('node:worker_threads'),path=require('node:path');
function create(base,{idleMs=60000,makeWorker=(...args)=>new Worker(...args)}={}){let worker=null,seq=0,timer;const pending=new Map();
 function open(){clearTimeout(timer);if(worker)return worker;worker=makeWorker(path.join(__dirname,'local-insights-worker.js'),{workerData:{base},resourceLimits:{maxOldGenerationSizeMb:384}});const owned=worker;
  worker.on('message',m=>{const p=pending.get(m.id);if(!p)return;if(m.progress){try{p.progress?.(m.progress);}catch{}return;}pending.delete(m.id);if(m.error)p.reject(Object.assign(Error(m.error),{code:m.code,cancelled:m.cancelled}));else p.resolve(m.value);if(!pending.size){owned.unref();timer=setTimeout(close,idleMs).unref();}});
  const failed=e=>{if(worker!==owned)return;if(e.code==='ERR_WORKER_OUT_OF_MEMORY')e=Object.assign(Error('本地数据整理时内存不足，本次读取已停止，已保存数据不受影响。可以重试，或先用导出数据查看已有记录。'),{code:e.code});clearTimeout(timer);worker=null;for(const p of pending.values())p.reject(e);pending.clear();};worker.on('error',failed);worker.on('exit',code=>{if(worker===owned)failed(Error('本地索引工作进程已结束，请重试'));});return worker;
 }
 function request(action,query={},extra={}){const w=open(),id=++seq;w.ref();return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,scope:action==='timeline'?'timeline':'search',progress:extra.progress});w.postMessage({id,action,query,...extra,progress:undefined});});}
 function cancel(scope){
  worker?.postMessage({action:'cancel',scope});
  for(const [id,p]of pending)if(!scope||p.scope===scope){
   pending.delete(id);p.reject(Object.assign(Error('已取消'),{cancelled:true}));
  }
  if(!pending.size){worker?.unref();clearTimeout(timer);if(worker)timer=setTimeout(close,idleMs).unref();}
 }
 function close(){clearTimeout(timer);const w=worker;worker=null;for(const p of pending.values())p.reject(Object.assign(Error('本地查询已结束，请重新搜索'),{cancelled:true}));pending.clear();w?.terminate();}
 return {request,cancel,close};
}
module.exports={create};
