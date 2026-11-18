'use strict';
// Only recover the historical exporter defect in absent user-post date values.
// Call after verifying the original manifest hash. Never evaluate package text.
const crypto=require('node:crypto');
const S=require('./exchange-schema');
function optionalDates(file,bytes){
 if(file.role!=='packet')return null;
 const text=bytes.toString('utf8');
 try{JSON.parse(text);return null;}catch{}
 const marker='\u0000reader-optional-date-'+crypto.randomUUID();let replaced=0;
 const repaired=text.replace(/"(?:\\[\s\S]|[^"\\])*"|undefined/g,token=>{if(token!=='undefined')return token;replaced++;return JSON.stringify(marker);});
 if(!replaced)return null;
 const slots=[];let value;
 try{value=JSON.parse(repaired,function(key,v){if(v===marker)slots.push({holder:this,key});return v;});}catch{return null;}
 if(value?.schema!==1||value.role!=='packet'||value.channel!=='user-posts'||value.owner?.kind!=='user'||!value.query||slots.length!==replaced)return null;
 if(slots.some(({holder,key})=>holder!==value.query||!['from','to','start_time','end_time'].includes(key)))return null;
 for(const {holder,key}of slots){if(key==='from'||key==='to')holder[key]='';else delete holder[key];}
 const normalized=Buffer.from(S.stable(value)),sha256=S.hash(normalized);
 return {bytes:normalized,file:{...file,sha256,bytes:normalized.length,path:'objects/'+file.owner.kind+'/'+file.owner.id+'/packet/'+sha256+'.json'},repair:{sourceHash:file.sha256,normalizedHash:sha256,fields:slots.map(s=>s.key).sort()}};
}
module.exports={optionalDates};
