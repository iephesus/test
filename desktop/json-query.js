'use strict';
// Bound short-lived, read-only JSON queries; never use this for an acquisition/save worker.
const {spawn}=require('node:child_process');
function invoke(cli,args,signal,{timeoutMs=20000,maxBytes=8*1024*1024,maxErrorBytes=4096,includeStderr=true,timeoutCode='JSON_QUERY_TIMEOUT',tooLargeCode='JSON_QUERY_TOO_LARGE',messages={},spawnChild=spawn,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 const text={cancelled:'JSON 查询已停止',timeout:'JSON 查询超时',tooLarge:'JSON 响应过大',failed:'JSON 查询未成功',invalid:'JSON 响应无法识别',...messages};
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(signal.reason||Object.assign(Error(text.cancelled),{code:'USER_CANCELLED'}));return;}
  const child=spawnChild(process.execPath,[cli,...args],{stdio:['ignore','pipe','pipe']});
  let output=[],errors=[],outputBytes=0,errorBytes=0,settled=false,stopping=null,exited=false,timer,killTimer,finishTimer;
  const clear=()=>{for(const value of [timer,killTimer,finishTimer])if(value!==undefined)clearTimer(value);};
  function finish(error,value){
   if(settled)return;settled=true;clear();signal?.removeEventListener('abort',abort);
   child.stdout.removeListener('data',onOutput);child.stderr.removeListener('data',onErrors);output=[];errors=[];
   error?reject(error):resolve(value);
  }
  function stop(error){
   if(settled||stopping)return;stopping=error;clear();output=[];errors=[];
   child.stdout.removeListener('data',onOutput);child.stderr.removeListener('data',onErrors);
   for(const stream of [child.stdout,child.stderr])try{stream.destroy?.();}catch{}
   try{child.kill('SIGTERM');}catch{}
   if(settled||exited){finish(error);return;}
   killTimer=setTimer(()=>{
    if(settled)return;try{child.kill('SIGKILL');}catch{}
    if(settled||exited){finish(error);return;}
    // A broken child/pipe must not keep the UI operation pending indefinitely.
    finishTimer=setTimer(()=>{try{child.unref?.();}catch{}finish(error);},1000);
   },1000);
  }
  function abort(){stop(signal.reason||Object.assign(Error(text.cancelled),{code:'USER_CANCELLED'}));}
  function onOutput(chunk){
   if(settled||stopping)return;const size=Buffer.byteLength(chunk);
   if(outputBytes+size>maxBytes){stop(Object.assign(Error(text.tooLarge),{code:tooLargeCode}));return;}
   outputBytes+=size;output.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
  }
  function onErrors(chunk){if(settled||stopping||errorBytes>=maxErrorBytes)return;const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk.slice(0,maxErrorBytes-errorBytes)),part=bytes.subarray(0,maxErrorBytes-errorBytes);errors.push(Buffer.from(part));errorBytes+=part.length;}
  function onError(error){if(settled)return;if(!child.pid)finish(error);else stop(error);}
  child.stdout.on('data',onOutput);child.stderr.on('data',onErrors);child.stdout.on('error',onError);child.stderr.on('error',onError);child.on('error',onError);
  child.on('exit',()=>{exited=true;if(stopping)finish(stopping);});
  child.on('close',code=>{
   exited=true;if(settled)return;if(stopping){finish(stopping);return;}
   if(code!==0){finish(Error(((includeStderr&&Buffer.concat(errors,errorBytes).toString('utf8'))||text.failed).slice(0,400)));return;}
   try{finish(null,JSON.parse(Buffer.concat(output,outputBytes).toString('utf8')));}catch{finish(Error(text.invalid));}
  });
  timer=setTimer(()=>stop(Object.assign(Error(text.timeout),{code:timeoutCode})),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
module.exports={invoke};
