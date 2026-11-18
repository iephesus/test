'use strict';
const crypto=require('node:crypto');
const {rawArray,apiError,normalize,userId,esc}=require('./core');
const id=value=>{if(typeof value==='number'&&!Number.isSafeInteger(value))return '';try{return /^\d+$/.test(String(value))&&BigInt(value)>0n?BigInt(value).toString():'';}catch{return '';}};

// Validate the raw response before it can support a negative observation.
// This is independent of export quotas and never makes a data request.
function inspectPacket(packet,count,maxId,kind,uid){
 const parsed=rawArray(packet.raw,kind),invalid=reason=>({valid:false,reason,empty:parsed?.items.length===0});
 if(!parsed||apiError(packet.raw))return invalid('响应失败或缺少记录数组');
 const items=parsed.items;if(packet.cached)return {valid:false,empty:!items.length,fingerprint:packet.responseHash||crypto.createHash('sha256').update(JSON.stringify(packet.raw)).digest('hex')};
 if(items.length>count)return invalid('响应超过请求数量');
 const box=parsed.container,value=box.next_cursor_str??box.next_cursor;
 if(value!=null&&(!/^\d+$/.test(String(value))||(typeof value==='number'&&!Number.isSafeInteger(value))))return invalid('续取游标无效');
 const next=value==null?null:BigInt(value).toString();let previous=null,minMs=null,maxMs=null;
 for(const raw of items){
  const recordId=id(raw.idstr??raw.id??raw.mid),row=normalize(raw,kind,uid);
  if(!recordId||!Number.isFinite(row.ms)||!String(row.content||'').trim())return invalid('记录缺少安全 ID、日期或正文');
  const current=BigInt(recordId);
  if((maxId&&current>BigInt(maxId))||(previous!=null&&current>previous))return invalid('响应超出范围或顺序异常');
  if(kind==='sent'&&userId(raw.user)!==uid)return invalid('作者 UID 不匹配');
  previous=current;minMs=minMs==null?row.ms:Math.min(minMs,row.ms);maxMs=maxMs==null?row.ms:Math.max(maxMs,row.ms);
 }
 if(next&&next!=='0'&&((maxId&&BigInt(next)>=BigInt(maxId))||(previous!=null&&BigInt(next)>previous)))return invalid('游标未推进或与记录矛盾');
 return {valid:true,empty:!items.length,next,minMs,maxMs,rawCount:items.length,fingerprint:packet.responseHash||crypto.createHash('sha256').update(JSON.stringify(packet.raw)).digest('hex')};
}
function analyzeAvailability(windows,archive,result,options){
 const a={schema:1,scope:'本次联网正式采集的已核实扫描区间',checkedAt:null,purpose:options.update?'update':options.updateBootstrap?'baseline':options.beforeMs!=null?'history-collect':options.refresh?'refresh':'collect',freshPages:0,cachePages:0,endCheckPages:0,seekPages:0,seekEmptyPages:0,replayedEmptyPages:0,scanEmptyPages:0,noNewEmptyPages:0,terminalEmptyPages:0,unknownEmptyPages:0,invalidPages:0,unverifiedDatePages:0,anonymousReports:0,reportedIds:[],knownNotReturnedIds:[],missingIds:[],locallySavedIds:[],missingBodyIds:[],returnedAgainIds:[]};
 const fresh=[],seen=new Set(),visible=new Set(),reported=new Set(),historical=new Set();
 const before=Number.isFinite(options.beforeMs)?options.beforeMs:Infinity;
 for(const w of windows){
  const v=w.availability;if(!v)continue;
  const key=[w.phase,w.maxId,w.sinceId,v.fingerprint||w.responseHash,w.cached?'cache':'wire'].join('|');if(seen.has(key))continue;seen.add(key);
  if(w.phase==='seek'){a.seekPages++;if(v.empty)a.seekEmptyPages++;continue;}
  if(w.phase==='verify-end'){a.endCheckPages++;continue;}
  if(w.cached){a.cachePages++;if(v.empty)a.replayedEmptyPages++;continue;}
  if(!v.valid){a.invalidPages++;continue;}
  if(Number.isFinite(options.beforeMs)&&(!result.located||(v.maxMs!=null&&v.maxMs>before))){a.unverifiedDatePages++;continue;}
  a.freshPages++;if(w.savedAt&&(!a.checkedAt||w.savedAt>a.checkedAt))a.checkedAt=w.savedAt;
  for(const recordId of w.ids)visible.add(recordId);
  const missing=w.missingIds.filter(recordId=>!w.sinceId||BigInt(recordId)>BigInt(w.sinceId));
  for(const recordId of missing)reported.add(recordId);
  if(w.unidentifiedMissing||w.invalidMissingIds)a.anonymousReports++;
  if(v.empty){
   if(v.next&&v.next!=='0')a.scanEmptyPages++;
   else if(v.next==='0'&&(options.update||options.updateBootstrap)&&!w.maxId&&!missing.length&&!w.unidentifiedMissing&&!w.invalidMissingIds)a.noNewEmptyPages++;
   else if(v.next==='0')a.terminalEmptyPages++;
   else a.unknownEmptyPages++;
  }
  // Empty terminal/unknown responses cannot certify an entire missing prefix.
  // A positive cursor excludes its own record, which may appear next page.
  const lower=v.next&&v.next!=='0'?BigInt(v.next)+1n:w.ids.length?w.ids.reduce((n,x)=>BigInt(x)<n?BigInt(x):n,BigInt(w.ids[0])):null;
  const upper=w.maxId?BigInt(w.maxId):w.ids.length?w.ids.reduce((n,x)=>BigInt(x)>n?BigInt(x):n,0n):null;
  if(lower!=null&&upper!=null&&lower<=upper)fresh.push({lower:w.sinceId&&lower<=BigInt(w.sinceId)?BigInt(w.sinceId)+1n:lower,upper});
 }
 // Merge scanned bands once, then test archive points in logarithmic time.
 const bands=[];for(const band of fresh.sort((a,b)=>a.lower<b.lower?-1:a.lower>b.lower?1:0)){const last=bands.at(-1);if(last&&band.lower<=last.upper+1n){if(band.upper>last.upper)last.upper=band.upper;}else bands.push({...band});}
 function contains(number){let lo=0,hi=bands.length-1;while(lo<=hi){const mid=(lo+hi)>>1,b=bands[mid];if(number<b.lower)hi=mid-1;else if(number>b.upper)lo=mid+1;else return true;}return false;}
 for(const [recordId,entry]of archive.records){
  if(!Number.isFinite(entry.row.ms)||entry.row.ms>before||visible.has(recordId))continue;
  const number=BigInt(recordId);if(contains(number))historical.add(recordId);
 }
 a.reportedIds=[...reported];a.returnedAgainIds=a.reportedIds.filter(recordId=>visible.has(recordId));
 a.knownNotReturnedIds=[...historical];a.missingIds=[...new Set([...reported,...historical])].filter(recordId=>!visible.has(recordId));
 // Body preservation and endpoint visibility are deliberately separate.
 const readable=new Set();for(const recordId of a.missingIds)if(String(archive.records.get(recordId)?.row.content||'').trim())readable.add(recordId);
 for(const row of result.rows)if(id(row.recordId)&&String(row.content||'').trim())readable.add(row.recordId);
 a.locallySavedIds=a.missingIds.filter(recordId=>readable.has(recordId));a.missingBodyIds=a.missingIds.filter(recordId=>!readable.has(recordId));
 return a;
}
function availabilityLines(a,{verbose=false}={}){
 if(!a)return [];const lines=[];
 if(a.missingIds.length)lines.push(`记录缺失检测：本次未返回 ${a.missingIds.length} 个已知 ID；本地有正文 ${a.locallySavedIds.length} 个，仍缺正文 ${a.missingBodyIds.length} 个。`);
 if(a.scanEmptyPages||a.seekEmptyPages)lines.push(`空页分类：正式采集空窗 ${a.scanEmptyPages} 个；日期定位空页 ${a.seekEmptyPages} 个（不参与缺失判定）。`);
 if(a.anonymousReports)lines.push('接口另有无法安全对应 ID 的缺失信息，无法推算具体条数。');
 if(a.invalidPages||a.unverifiedDatePages||a.unknownEmptyPages)lines.push('部分响应的范围或续取依据不足，未用于推断缺失记录。');
 if(a.missingIds.length||a.scanEmptyPages)lines.push('本次未返回不等于已删除；本地补全只表示正文已保存。');
 if(verbose)lines.push(`检测来源：联网正式采集 ${a.freshPages} 页，缓存重放 ${a.cachePages} 页，日期定位 ${a.seekPages} 页；无新增空页 ${a.noNewEmptyPages} 个，末尾空页 ${a.terminalEmptyPages} 个。`);
 return lines;
}
function availabilityNote(meta){
 const sources=meta.map(s=>s.availability).filter(Boolean),missing=new Set(sources.flatMap(a=>a.missingIds)),saved=new Set(sources.flatMap(a=>a.locallySavedIds)),empty=sources.reduce((n,a)=>n+a.scanEmptyPages,0);
 if(!missing.size&&!empty)return '';
 const text=missing.size?`本次未返回 ${missing.size} 个已知 ID（本地有正文 ${[...missing].filter(x=>saved.has(x)).length} 个）`:`采集空窗 ${empty} 个`;
 return ` <span class="recovery-note availability-note" title="${esc('仅分析本次联网正式采集；日期定位和缓存重放不参与。本次未返回或空窗不能直接确认删除，本地有正文不代表当前仍可见。')}">· ${text}</span>`;
}
module.exports={inspectPacket,analyzeAvailability,availabilityLines,availabilityNote};
