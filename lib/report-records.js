'use strict';
const {exactId}=require('./completeness');
function jsonPayload(value){return JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
function locateReportPayload(html,tree){
 const pending=[tree||require('parse5').parse(html,{sourceCodeLocationInfo:true})];
 let payload=null;
 while(pending.length){
  const node=pending.pop(),id=node.attrs?.find(a=>a.name==='id')?.value;
  if(id==='weibo-report-records'||id==='weibo-merged-records'){
   const loc=node.sourceCodeLocation,type=node.attrs.find(a=>a.name==='type')?.value;
   if(payload||node.namespaceURI!=='http://www.w3.org/1999/xhtml'||node.tagName!=='script'||type!=='application/json'||!loc?.endTag)return {invalid:true};
   payload={id,text:html.slice(loc.startTag.endOffset,loc.endTag.startOffset)};
  }
  // Template content is kept separately by parse5 and is outside the active DOM.
  for(const child of node.childNodes||[])pending.push(child);
 }
 return payload;
}
function reportPayload(html,uid){
 const match=html.match(/<script type="application\/json" id="(?:weibo-report-records|weibo-merged-records)">([\s\S]*?)<\/script>/);if(!match)return null;
 try{const p=JSON.parse(match[1]);if(p.uid!==uid||!Array.isArray(p.rows))return null;return {...p,rows:p.rows.filter(r=>exactId(r.recordId)&&!r.isContext&&typeof r.content==='string')};}catch{return null;}
}
function formalIds(html,uid){const p=reportPayload(html,uid);return p?p.rows.map(r=>r.recordId):[...new Set([...html.matchAll(/\bdata-item\b[^>]*\bdata-comment-id="(\d+)"/g)].map(m=>m[1]))];}
module.exports={jsonPayload,locateReportPayload,reportPayload,formalIds};

// Independent-post management cannot use a user UID as report ownership. Modern
// payloads bind every formal comment to its exact post; legacy markup must carry
// the same explicit enclosing post identity and post reading mode.
function formalPostIds(html,postId){
 if(exactId(postId)!==postId)throw Error('报告微博身份无效');
 const match=html.match(/<script type="application\/json" id="(?:weibo-report-records|weibo-merged-records)">([\s\S]*?)<\/script>/);
 if(match){let value;try{value=JSON.parse(match[1]);}catch{throw Error('报告正式记录数据无法核实，原文件保留');}if(!Array.isArray(value.rows))throw Error('报告缺少正式记录数据，原文件保留');return [...new Set(value.rows.filter(r=>r&&!r.isContext&&r.group==='post-comments'&&r.postId===postId&&exactId(r.recordId)&&typeof r.content==='string').map(r=>r.recordId))];}
 const ids=new Set();let postMode=false;const tree=require('parse5').parse(html);
 function walk(node,owner=''){const a=Object.fromEntries((node.attrs||[]).map(x=>[x.name,x.value]));if(node.tagName==='body')postMode=a['data-color-mode']==='posts';if(Object.hasOwn(a,'data-post-group'))owner=a['data-post-id']||'';if(postMode&&owner===postId&&node.tagName==='article'&&Object.hasOwn(a,'data-item')&&!Object.hasOwn(a,'data-context')&&exactId(a['data-comment-id']))ids.add(a['data-comment-id']);for(const child of node.childNodes||[])walk(child,owner);}
 walk(tree);return [...ids];
}
module.exports.formalPostIds=formalPostIds;
