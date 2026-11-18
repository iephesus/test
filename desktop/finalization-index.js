'use strict';
// Rebuildable pending-journal locator, never a replacement for the raw journal.
// Every entry is bound to the source inode/ctime/mtime/size; pending journals are
// reread by the finalizer before any side effect. Completed audit files remain.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),views=require('../lib/file-view-cache');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function pending(folder,{inventory=false}={}){
 const m=views.manifest(folder,{filter:/^[a-f0-9-]{36}\.json$/,strict:true}),file=path.join(path.dirname(folder),'indexes','finalization-v1.json');let previous={};
 try{const box=views.readJSON(file);if(box.schema===1&&box.files&&typeof box.files==='object'&&!Array.isArray(box.files)&&box.hash===digest(box.files))previous=box.files;}catch{}
 const next={},wanted=[];let changed=false;
 for(const e of m.files){const name=path.basename(e.file),old=previous[name];let value=old;
  if(!old||typeof old.pending!=='boolean'||typeof old.inventory!=='boolean'||old.signature!==e.signature){changed=true;try{const raw=JSON.parse(fs.readFileSync(e.file,'utf8'));value={signature:e.signature,pending:!(raw?.schema===1&&raw.id+'.json'===name&&raw.status==='settled'),inventory:raw?.result?.persistence?.coreSaved===true&&raw?.result?.partialFailures?.some(f=>f.stage==='inventory-index')===true};}catch{value={signature:e.signature,pending:true};}}
  if(views.stamp(e.file)?.signature!==e.signature)value={signature:e.signature,pending:true};
  next[name]=value;if(inventory?value.inventory:value.pending)wanted.push(name);
 }
 if(Object.keys(previous).length!==m.files.length)changed=true;
 if(changed)try{require('../lib/update-progress').atomic(file,{schema:1,files:next,hash:digest(next)});}catch{} // an index failure cannot prevent raw recovery
 return wanted;
}
module.exports={pending,inventoryFailures:folder=>pending(folder,{inventory:true})};
