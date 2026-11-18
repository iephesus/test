'use strict';
// Lossless JSON recipes only; SQLite, paths and publication stay in the store.
const crypto=require('node:crypto'),zlib=require('node:zlib');
const MAX_ORIGINAL=128*1024*1024,hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function create({maxOriginal=MAX_ORIGINAL}={}){
 if(!Number.isSafeInteger(maxOriginal)||maxOriginal<1||maxOriginal>MAX_ORIGINAL)throw Error('共享内容上限无效');
 function sizeLimit(size){if(!Number.isSafeInteger(size)||size<0||size>maxOriginal)throw Error('共享内容引用无效');return size;}
 function recipeLimit(size){
  sizeLimit(size);
  // Literal JSON escapes cost at most 2x their original UTF-8 bytes. A chunk
  // replaces >=32 bytes with <=81 bytes including separators/literal wrappers.
  // Thus every generated recipe fits 3*originalBytes plus its array overhead.
  return size*3+4;
 }
 function encode(bytes,saveChunk){
  sizeLimit(bytes.length);JSON.parse(bytes);
  const parts=[],text=bytes.toString('utf8'),pattern=/"(?:[^"\\]|\\[\s\S])*"/g;let at=0;
  for(const m of text.matchAll(pattern)){
   if(Buffer.byteLength(m[0])<32)continue;
   parts.push(text.slice(at,m.index));const raw=Buffer.from(m[0]),id=hash(raw);parts.push({chunk:id});saveChunk(id,raw);at=m.index+m[0].length;
  }
  parts.push(text.slice(at));const recipe=Buffer.from(JSON.stringify(parts));if(recipe.length>recipeLimit(bytes.length))throw Error('共享内容配方超过原文推导上限');
  return {hash:hash(bytes),size:bytes.length,recipe:zlib.deflateRawSync(recipe)};
 }
 function recipeParts(recipe,size){
  const parts=JSON.parse(zlib.inflateRawSync(recipe,{maxOutputLength:recipeLimit(size)}));
  if(!Array.isArray(parts)||parts.some(p=>typeof p!=='string'&&(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==1||!/^[a-f0-9]{64}$/.test(p.chunk||''))))throw Error('共享内容块引用无效');
  return parts;
 }
 function inflateChunk(bytes,id,maxBytes){
  sizeLimit(maxBytes);if(!/^[a-f0-9]{64}$/.test(id))throw Error('共享内容块引用无效');
  const raw=zlib.inflateRawSync(bytes,{maxOutputLength:Math.max(1,maxBytes)});if(raw.length>maxBytes)throw Error('共享内容展开长度超限');if(hash(raw)!==id)throw Error('共享内容块哈希损坏');return raw;
 }
 function decode(document,id,size,readChunk){
  sizeLimit(size);if(!/^[a-f0-9]{64}$/.test(id)||!document||document.size!==size)throw Error('共享内容缺失或长度不匹配');
  const parts=recipeParts(document.recipe,size),buffers=[];let length=0;
  for(const part of parts){const bytes=typeof part==='string'?Buffer.from(part):readChunk(part.chunk,size-length);length+=bytes.length;if(length>size)throw Error('共享内容展开长度超限');buffers.push(bytes);}
  const bytes=Buffer.concat(buffers,length);if(length!==size||hash(bytes)!==id)throw Error('共享响应原始哈希不匹配');return {bytes,parts};
 }
 return {maxOriginal,recipeLimit,encode,recipeParts,inflateChunk,decode};
}
module.exports={MAX_ORIGINAL,create,...create()};
