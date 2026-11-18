'use strict';
// A completed CLI protocol response is distinct from a transport exception and
// from fee settlement. Never classify by human-readable error text.
const crypto=require('node:crypto'),LIMIT=64*1024,PROTOCOL='cli-stderr-service-error-v1';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function classify(result,args){
 if(!Array.isArray(args))return null;const at=args.lastIndexOf('--output');if(at<0||args[at+1]!=='json'||result.error||result.signal||result.status!==1||typeof result.stderr!=='string'||typeof result.stdout!=='string'||result.stdout!=='')return null;
 const bytes=Buffer.byteLength(result.stderr);if(!bytes||bytes>LIMIT)return null;
 let value;try{value=JSON.parse(result.stderr);}catch{return null;}
 if(!value||Array.isArray(value)||value.success!==false||Object.keys(value).some(key=>!['success','error'].includes(key))||!value.error||typeof value.error!=='object'||Array.isArray(value.error)||value.error.code!=='IP_GEO_DENIED')return null;
 return {protocol:PROTOCOL,code:'IP_GEO_DENIED',complete:true,exitCode:result.status,stderrBytes:bytes,stderrHash:hash(result.stderr),stdoutBytes:Buffer.byteLength(result.stdout),stdoutHash:hash(result.stdout)};
}
function safeCapture(value){
 if(value?.protocol!==PROTOCOL||value.code!=='IP_GEO_DENIED'||value.complete!==true||value.exitCode!==1||!Number.isSafeInteger(value.stderrBytes)||value.stderrBytes<1||value.stderrBytes>LIMIT||value.stdoutBytes!==0||value.stdoutHash!==hash('')||!/^[a-f0-9]{64}$/.test(value.stderrHash||''))return null;
 return {protocol:PROTOCOL,code:'IP_GEO_DENIED',complete:true,exitCode:value.exitCode,stderrBytes:value.stderrBytes,stderrHash:value.stderrHash,stdoutBytes:0,stdoutHash:hash('')};
}
function description(receipt){return {code:'IP_GEO_DENIED',category:'region',nextAction:'account-settings',retryPolicy:'bounded-owner-recovery',billing:'unverified',...(receipt?{receipt}: {})};}
function publicValue(value){
 const ref=value?.receipt;if(value?.code!=='IP_GEO_DENIED'||value.category!=='region'||value.billing!=='unverified'||!ref||typeof ref.file!=='string'||!/^cache\/(?:request-journal\/[a-f0-9-]{36}\.rejection|service-rejections\/[a-f0-9-]{36})\.json$/.test(ref.file)||!/^[a-f0-9]{64}$/.test(ref.hash||''))return null;
 return description({file:ref.file,hash:ref.hash});
}
const message='WeiboCLI 当前不支持此网络所在地区。可在“账户与设置”查看服务条件；订阅设置和已保存内容保留，下一次核查遵守访问保护和原预算，不会自动切换网络或原样重发旧请求。';
module.exports={PROTOCOL,LIMIT,classify,safeCapture,description,publicValue,message};
