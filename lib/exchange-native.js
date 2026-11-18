'use strict';
// Recognize already-present request evidence without creating imported copies.
// These hashes only suppress identical storage; they never certify a head.
const fs=require('node:fs'),path=require('node:path'),S=require('./exchange-schema');
const read=file=>JSON.parse(require('./regular-file').read(file,{maxBytes:128*1024*1024}));
const key=v=>S.hash(S.stable({owner:v.owner,channel:v.channel,query:v.query,response:v.response,trusted:v.trusted}));
function keys(dir,owner,kind){const result=new Set(),cache=path.join(dir,'cache');if(!fs.existsSync(cache))return result;
 function add(q,raw){try{const v={owner,channel:kind,query:S.query(q,owner,kind),response:S.response(raw,kind),trusted:true};try{require('./exchange-records').validatePacket({...v,savedAt:'2000-01-01T00:00:00Z'});}catch{v.trusted=false;}result.add(key(v));}catch{}}
 for(const name of fs.readdirSync(cache)){const m=name.match(/^(sent|received|mentions-comments|mentions-posts|post-comments)_c(\d+)_m(\d+)(?:_s(\d+))?(?:_p(\d+))?(?:_legacy_[a-f0-9]{16})?\.json$/);if(m&&m[1]===kind){add({count:Number(m[2]),maxId:m[3]==='0'?'':m[3],sinceId:m[4]||'',page:Number(m[5]||1)},read(path.join(cache,name)));}else if(name===kind+'_page1.json'){const raw=read(path.join(cache,name));add({count:Math.max(1,require('./core').rawArray(raw,kind)?.items.length||1)},raw);}else if(kind==='user-posts'&&name.startsWith('user-posts_')&&name.endsWith('.json')){const box=read(path.join(cache,name));if(box.query?.uid===owner.id)add(box.query,box.response);}}
 const journal=path.join(cache,'request-journal');if(fs.existsSync(journal))for(const name of fs.readdirSync(journal).filter(n=>n.endsWith('.response.json'))){const box=read(path.join(journal,name));if(box.query?.uid===owner.id&&box.query.kind===kind)add(box.query,box.response);}
 return result;
}
module.exports={key,keys};
