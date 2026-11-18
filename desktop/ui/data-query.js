(function(root){
 'use strict';
 // Pure task boundary: identity is explicit; form drafts never supply a hidden target.
 function build(state,field,identity,preview=false){
  const sync=state.task==='sync',user=state.category==='users',posts=state.category==='posts';
  const mode=user?field('mode').value:posts?'user-posts':'post-comments';
  const quick=sync&&user&&state.updateOperation==='quick';
  const range=sync?posts||user&&!quick&&field('date-range-enabled').checked:field('view-range-enabled').checked;
  return {
   target:identity.target(state),subject:identity.subject(state),mode,
   policy:sync?(quick?'update':'cache'):'database',syncOnly:sync,task:state.task,...(sync&&!user&&!posts?{source:'cli'}:{}),
   syncOperation:quick?'quick':'regular',dateRange:!!field('date-range-enabled').checked,
   markUnread:!sync&&field('mark-unread').checked,...(!sync&&user&&['comments-sent','comments-received','comments-both'].includes(mode)?{peerUid:(field('report-peer')?.value||'').trim()}:{}),
   limit:field('limit').value.trim(),unlimited:field('unlimited').checked,
   returnBudget:sync?field('return-budget').value.trim():'',
   pages:field('pages').value.trim(),pageSize:field('page-size').value.trim(),
   from:range?field('from').value:'',to:range?field('to').value:'',before:'',
   seekLimit:field('seek-limit').value,emptyWindowLimit:field('empty-limit').value,
   historyRecovery:true,downloadImages:sync&&posts&&field('download-images').checked,
   fullText:sync&&posts&&field('full-text').checked,verbose:field('verbose').checked,preview
  };
 }
 function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));return value;}
 function key(q){return JSON.stringify(canonical({...q,preview:false}));}
 function task(value,policy){return ['sync','report'].includes(value)?value:['database','offline'].includes(policy)?'report':'sync';}
 // Retire inactive dates that older versions filled automatically. Explicit
 // enabled ranges and all drafts saved under the new default stay intact.
 function dateDrafts(saved){
  const drafts=saved?.filtersByUser;if(!drafts||typeof drafts!=='object'||Array.isArray(drafts))return {};
  return Object.fromEntries(Object.entries(drafts).map(([owner,tasks])=>[owner,Object.fromEntries(Object.entries(tasks||{}).map(([name,draft])=>[name,!(saved.dateDefaultsVersion>=1)&&draft&&!draft.range?{...draft,from:'',to:''}:draft]))]));
 }
 const api={build,key,task,dateDrafts};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ReaderDataQuery=api;
})(globalThis);
