'use strict';
// Owns local-only requests, display caches and auxiliary report maintenance.
// Collection tasks and subscription scheduling stay with their existing owners.
function createLocalActions({ workspace, publish, validateSubject, targetUid, inventoryRepairs, reportAccess, pendingReports=()=>[], terminating, isBusy=()=>false, library, listReports, clean }) {
 let view = null, viewBase = null;
 const timers = new Set(), maintenance = new Map(),observers=new Map(),snapshotBindings=new Map();
 function snapshotKey(query){const o=require('./local-view').validate(query);return JSON.stringify([o.uid||'',o.postId||'',o.mode,Number.isFinite(o.count)?o.count:null,o.startMs,o.endMs,o.peerUid||'',o.markUnread,o.unreadOnly,o.unreadContext,query.source||'local']);}
 function rememberSnapshot(base,query,token){snapshotBindings.delete(token);snapshotBindings.set(token,{base:require('../lib/data-layout').canonical(base),query:snapshotKey(query)});while(snapshotBindings.size>128)snapshotBindings.delete(snapshotBindings.keys().next().value);}
 function resumeMaintenance(base){if(!observers.has(base))observers.set(base,require('../lib/report-catalog').observeMaintenance(base,event=>publish(base)('localWriteState',event),{canRun:()=>!terminating()&&!isBusy()}));require('../lib/report-catalog').resumeMaintenance(base);}
 function service() {
  const base = workspace();
  if (viewBase !== base) { view = null; viewBase = base; }
  return view ??= require('./local-view').createLocalView(base);
 }
 function invalidate() { view = null; viewBase = null; }
 function close() { for (const timer of timers) clearTimeout(timer); timers.clear(); maintenance.clear();for(const [base,stop]of observers){stop();require('../lib/report-catalog').pauseMaintenance(base);}observers.clear();snapshotBindings.clear(); invalidate(); }
 function input(query = {}) {
  const captured = structuredClone(query);
  validateSubject(captured);
  captured.target = captured.mode === 'post-comments' ? String(captured.target) : targetUid(captured.target);
  return captured;
 }
 async function handle(message) {
  const base = workspace(), notify = publish(base), requestId = message.requestId;
  const query = input(message.query);
  if (message.action === 'localInventory') {
   const local = require('./local-inventory'), q = local.query(query), location = local.locate(base, q);
   const request = inventoryRepairs().request(q), snapshot = await request.promise;
   notify('localInventory', { requestId, query: q, summary: snapshot.totals[location.kind] });
   return;
  }
  if (message.action === 'localData') {
   const value = service().prepare(query);
   rememberSnapshot(base,query,value.token);
   notify('localData', { requestId, token: value.token, query, label: value.label, summary: value.summary });
   return;
  }
  if (message.action !== 'localExport') throw Error('不支持的本地数据操作');
  let result, opening = null, openError = null;
  require('../lib/report-lifecycle').locked(base,()=>{
  const binding=message.token?snapshotBindings.get(message.token):null;
  if(binding&&(binding.base!==require('../lib/data-layout').canonical(base)||binding.query!==snapshotKey(query)))throw Error('本地查看条件已变化，未使用其他范围的快照');
  try{result = service().exportCurrent(query, message.token,null,{retainedSnapshot:true});}
  catch(error){
   if(error.code!=='LOCAL_SNAPSHOT_STALE'||!binding)throw error;
   // The displayed token was issued for these exact captured conditions, but
   // its bounded body cache was evicted/rebuilt. Refresh once, then validate
   // and export one complete new generation instead of asking for another click.
   const refreshed=service().prepare(query);rememberSnapshot(base,query,refreshed.token);
   result={...service().exportCurrent(query,refreshed.token,null,{retainedSnapshot:true}),snapshotRefreshed:true};
  }
  if (message.openWhenReady && result.files[0]) {
   try { opening = reportAccess().open(result.files[0]); } catch (error) { openError = error; }
  }
  });
  notify('localExported', { requestId, query, ...result, cleanup: null, openDispatched: !!message.openWhenReady });
  if (opening) notify('open', opening);
  if (openError) notify('browserOpenFailed', { id: result.files[0], message: clean(openError.message) });
  deferMaintenance(base,result.files);
 }
 function deferMaintenance(base,files) {
  resumeMaintenance(base);require('../lib/report-catalog').defer(base,files);
  const notify=publish(base);
  function add(pending,files){const catalog=require('../lib/report-catalog').metadata(base).entries,grouped=new Map();for(const file of files){const owner=require('./library').reportOwnerOf(file,catalog)||file;if(!grouped.has(owner))grouped.set(owner,[]);grouped.get(owner).push(file);}for(const [owner,current]of grouped)pending.owners.set(owner,current);}
  // Dispatch first; cleanup/list failures cannot undo a saved or opened report.
  let pending=maintenance.get(base);if(pending){add(pending,files);return;}
  pending={owners:new Map()};add(pending,files);maintenance.set(base,pending);
  const timer = setTimeout(() => {
   timers.delete(timer);maintenance.delete(base);const files=[...pending.owners.values()].flat(),owners=new Set([...pending.owners.keys()].filter(key=>/^(?:user|post):\d{5,20}$/.test(key)));
   if (terminating() || !require('node:fs').existsSync(base)) return;
   const writeId='report-maintenance:'+Date.now();notify('localWriteState',{requestId:writeId,busy:true});
   let unlock;
   try { unlock=require('../lib/workspace-access').enter(base,'writer');if (files.length) {const result=library.cleanupOwnerReports(base,files);if(result?.deferred)notify('refreshWarning',{stage:'report-cleanup',message:'报告已保存，等待浏览器交接或其他进程完成后自动整理旧报告。'});} }
   catch (error) { require('../lib/report-catalog').defer(base,files);notify('refreshWarning', { stage: 'report-cleanup', message: '报告已保存，旧报告暂未清理：' + clean(error.message) }); }
   try { if(owners.size)notify('reportsUpdated', { owners:[...owners], reports: listReports(base,{database:[],owners}) }); }
   catch (error) { notify('refreshWarning', { stage: 'report-list', message: clean(error.message) }); }
   finally {unlock?.();notify('localWriteState',{requestId:writeId,busy:false});}
  }, 200);
  timer.unref(); timers.add(timer);
 }
 return { handle, service, invalidate, close, deferMaintenance, resumeMaintenance };
}
module.exports = { createLocalActions };
