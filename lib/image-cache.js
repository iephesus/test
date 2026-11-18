'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {pictureUrl}=require('./core');
function imageType(bytes){
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
 if(/^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')))return 'gif';
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'webp';
 if(bytes.subarray(4,8).toString()==='ftyp'&&/avif|avis/.test(bytes.subarray(8,32).toString()))return 'avif';
 return '';
}
function inspectImage(file){
 let fd;try{fd=require('./regular-file').open(file);const bytes=Buffer.alloc(32),n=fs.readSync(fd,bytes,0,32,0);return imageType(bytes.subarray(0,n));}catch{return '';}finally{if(fd!=null)fs.closeSync(fd);}
}
function downloadImage(url,file){
 const validate=value=>{const normalized=pictureUrl(value);if(!normalized)throw Error('图片地址无效');const parsed=new URL(normalized);if(parsed.protocol!=='https:'||!/(^|\.)sinaimg\.(cn|com)$/i.test(parsed.hostname)||parsed.port)throw Error('只下载接口返回的新浪 HTTPS 图片地址');return normalized;};
 let address=validate(url);const until=Date.now()+30000;
 const executable=process.platform==='darwin'?'/usr/bin/curl':'curl';
 for(let hop=0;hop<=3;hop++){
  const remaining=until-Date.now();if(remaining<=0)throw Error('图片下载超时');
  // Inspect each redirect before contacting it; curl --location validates only the first host.
  const result=spawnSync(executable,['-q','--silent','--show-error','--proto','=https','--max-time',String(Math.max(0.001,remaining/1000)),'--max-filesize','20971520','--output',file,'--write-out','%{http_code}\n%{content_type}\n%{redirect_url}',address],{encoding:'utf8',timeout:remaining+1000,maxBuffer:8192});
  if(result.error||result.status!==0)throw Error('图片下载失败');
  const [status,type,next]=String(result.stdout||'').split('\n');
  if(status==='200'&&/^image\//i.test(type))return;
  if(!/^30[12378]$/.test(status)||!next)throw Error('图片下载失败：响应不是图片');
  if(hop===3)throw Error('图片跳转次数过多');
  if(new URL(next,address).protocol!=='https:')throw Error('图片跳转必须使用 HTTPS');
  address=validate(new URL(next,address).href);
 }
}
function cachePostImages(rows,dir,options,download=downloadImage){
 const folder=path.join(dir,'images'),assets=new Map();let downloaded=0,reused=0,failed=0,bytes=0,missingLinks=0,knownPictures=0;
 const sources=rows.flatMap(row=>[row,row.repost].filter(Boolean));
 for(const source of sources){
  const pictures=source.pictures||{total:0,items:[]};knownPictures+=pictures.total;
  missingLinks+=Math.max(0,pictures.total-pictures.items.length);source.localImages=[];
  for(const picture of pictures.items){
   const url=pictureUrl(picture.url);if(!url)continue;
   let asset=assets.get(url);
   if(!asset){
    const hash=crypto.createHash('sha256').update(url).digest('hex');let filename='';
    for(const extension of ['jpg','png','gif','webp','avif']){const candidate=hash+'.'+extension;if(inspectImage(path.join(folder,candidate))){filename=candidate;break;}}
    if(filename){reused++;asset={file:'images/'+filename,bytes:fs.statSync(path.join(folder,filename)).size};}
    else if(options.offline){failed++;asset={error:'离线模式未找到已保存的图片'};}
    else{
     fs.mkdirSync(folder,{recursive:true});const temporary=path.join(folder,hash+'.'+crypto.randomUUID()+'.part');
     try{download(url,temporary);const extension=inspectImage(temporary);if(!extension)throw Error('返回内容不是支持的图片文件');filename=hash+'.'+extension;fs.renameSync(temporary,path.join(folder,filename));downloaded++;asset={file:'images/'+filename,bytes:fs.statSync(path.join(folder,filename)).size};}
     catch(error){failed++;asset={error:error.message};}
     finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    }
    assets.set(url,asset);if(asset.file)bytes+=asset.bytes;
   }
   if(asset.file)source.localImages.push({...asset,url});
  }
 }
 return {downloaded,reused,failed,bytes,missingLinks,knownPictures,uniqueImages:assets.size};
}
module.exports={imageType,inspectImage,downloadImage,cachePostImages};
