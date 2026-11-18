'use strict';
// Reuse the same HTML renderer for an all-directions selection. One owner gets
// one output, with typed formal records rather than three expiring file links.
function combine(jobs){
 const {recordKey}=require('./records'),rows=new Map(),sources=[];
 for(const job of jobs){sources.push(...(job.sources||[]));for(const row of job.rows){const key=recordKey(row),old=rows.get(key);if(!old){rows.set(key,row);continue;}
  const directions=[...new Set([...(old.directions||[old.group]),...(row.directions||[row.group])])],main=old.group.startsWith('mentions-')&&!row.group.startsWith('mentions-')?row:old,extra=main===old?row:old;
  rows.set(key,{...require('./exchange-merge').merge(main,extra,main.group),directions});
 }}
 return [{kind:'all',rows:require('./core').sortRecords([...rows.values()]),sources}];
}
module.exports={combine};
