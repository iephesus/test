'use strict';
// Snapshots are overlapping observations, not separate bodies. Collapse ONLY
// exactly equal whitelisted rows within an exact owner/direction. Different
// texts, quoted context, metadata and media all remain independently retained.
const S=require('./exchange-schema');
const BUFFER_BYTES=16*1024*1024;
function create(owner,{store,maxBufferedBytes=BUFFER_BYTES}={}){const groups=new Map();let observed=0,unique=0,bufferedBytes=0;
 if(!Number.isSafeInteger(maxBufferedBytes)||maxBufferedBytes<0||maxBufferedBytes>BUFFER_BYTES)throw Error('独立记录缓冲上限无效');
 function textFor(hash,row){if(row.text!==undefined)return row.text;const bytes=store?.get(hash);if(!Buffer.isBuffer(bytes)||S.hash(bytes)!==hash)throw Error('独立记录暂存哈希损坏');return bytes.toString('utf8');}
 function add(kind,rows,savedAt,{skipInvalid=false}={}){S.channel(owner,kind);if(!Number.isFinite(Date.parse(savedAt)))throw Error('独立记录采集时间无效');let group=groups.get(kind);if(!group)groups.set(kind,group=new Map());
  for(const source of rows){let row;try{row=S.row(source,kind);}catch(error){if(skipInvalid)continue;throw error;}const text=S.stable(row),hash=S.hash(text),old=group.get(hash);observed++;
   if(old){if(textFor(hash,old)!==text)throw Error('独立记录内容哈希冲突');if(Date.parse(savedAt)<Date.parse(old.savedAt))old.savedAt=savedAt;}
   else{const size=Buffer.byteLength(text);if(bufferedBytes+size<=maxBufferedBytes){group.set(hash,{text,savedAt});bufferedBytes+=size;}else{if(!store)throw Error('独立记录缺少私有暂存');store.put(Buffer.from(text),hash);group.set(hash,{savedAt});}unique++;}
  }
 }
 async function flush(write,checkpoint){for(const [channel,rows]of [...groups].sort(([a],[b])=>a.localeCompare(b))){const times=new Map();for(const [hash,row]of [...rows].sort(([a],[b])=>a.localeCompare(b))){let at=times.get(row.savedAt);if(!at)times.set(row.savedAt,at=[]);at.push([hash,row]);}
  for(const [savedAt,entries]of [...times].sort(([a],[b])=>a.localeCompare(b)))for(let i=0;i<entries.length;i+=500){await checkpoint();write({schema:1,role:'records',owner:S.owner(owner),channel,savedAt,rows:entries.slice(i,i+500).map(([hash,row])=>JSON.parse(textFor(hash,row)))});}
 }groups.clear();bufferedBytes=0;return {observed,unique};}
 return {add,flush};
}
module.exports={create,BUFFER_BYTES};
