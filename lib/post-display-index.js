'use strict';
// Disposable SQLite display index. Originals remain authoritative; never use this
// module in collection, budget or continuity/checkpoint decisions.
const fs = require('node:fs');
const path = require('node:path');
const sources = require('./post-local-sources');
const views = require('./file-view-cache');
const digest = sources.digest;
const implementation = digest(['post-display-index', 'post-local-sources', 'post-comments', 'core', 'comment-media', 'record-body', 'exchange-records', 'exchange-schema', 'exchange-merge', 'record-quality'].map(name => digest(fs.readFileSync(require.resolve('./' + name)))).join('|'));
function create(dir, id, { inject = () => {} } = {}) {
 const file = path.join(dir, 'cache/view-indexes/post-display-v1.sqlite');
 const sealFile = file + '.seal.json';
 const stats = { sourceReads: 0, rebuiltRows: 0, selectedRows: 0, rebuilds: 0 };
 function open() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink() || fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw Error('本地显示索引路径无效');
  const db = new (require('node:sqlite').DatabaseSync)(file);
  db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA cache_size=-4096; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sources(name TEXT PRIMARY KEY,signature TEXT NOT NULL,warning TEXT NOT NULL,preferred TEXT,label TEXT,stamp REAL); CREATE TABLE IF NOT EXISTS candidates(source TEXT NOT NULL,ordinal INTEGER NOT NULL,id TEXT NOT NULL,role TEXT NOT NULL,stamp REAL,savedAt TEXT,hash TEXT,row TEXT NOT NULL,PRIMARY KEY(source,ordinal)); CREATE INDEX IF NOT EXISTS candidate_id ON candidates(id); CREATE TABLE IF NOT EXISTS rows(id TEXT NOT NULL,context INTEGER NOT NULL,ms REAL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(id,context)); CREATE INDEX IF NOT EXISTS display_time ON rows(context,ms DESC,length(id) DESC,id DESC);');
  db.exec('CREATE TABLE IF NOT EXISTS source_authors(name TEXT PRIMARY KEY, evidence TEXT NOT NULL)');
  return db;
 }
 function sync(db) {
  const before = sources.manifest(dir, id), meta = Object.fromEntries(db.prepare('SELECT * FROM meta').all().map(item => [item.key, item.value]));
  if (meta.owner === id && meta.implementation === implementation && meta.signature === before.signature && Number(meta.count) === db.prepare('SELECT count(*) n FROM rows').get().n) return;
  db.exec('BEGIN IMMEDIATE');
  try {
   if (meta.owner !== id || meta.implementation !== implementation || meta.count != null && Number(meta.count) !== db.prepare('SELECT count(*) n FROM rows').get().n) db.exec('DELETE FROM candidates; DELETE FROM sources; DELETE FROM source_authors; DELETE FROM rows; DELETE FROM meta;');
   const old = new Map(db.prepare('SELECT * FROM sources').all().map(item => [item.name, item]));
   const current = new Set(before.files.map(item => item.file));
   const affected = new Set(); let preferencesChanged = false;
   const poolChanged = meta.poolSignature !== before.poolSignature;
   const ids = db.prepare('SELECT DISTINCT id FROM candidates WHERE source=?');
   const drop = db.prepare('DELETE FROM candidates WHERE source=?');
   const save = db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?)');
   const saveAuthors = db.prepare('INSERT OR REPLACE INTO source_authors VALUES(?,?)');
   const dropAuthors = db.prepare('DELETE FROM source_authors WHERE name=?');
   const insert = db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?)');
   for (const item of before.files) {
    // An unchanged exchange reference can resolve to replaced or damaged shared
    // bytes. Reproject it when the backing pool changes, not only the reference.
    const relative = path.relative(path.join(dir, 'cache'), item.file);
    const dependsOnPool = relative.startsWith('exchange-v1' + path.sep);
    if (old.get(item.file)?.signature === item.signature && !(poolChanged && dependsOnPool)) continue;
    for (const row of ids.all(item.file)) affected.add(row.id);
    drop.run(item.file);
    let warning = '', projection = { rows: [] };
    try { stats.sourceReads++; projection = sources.project(item, dir, id); }
    catch (error) { warning = path.basename(item.file) + '：' + error.message; }
    if (views.stamp(item.file)?.signature !== item.signature) throw Error('本地数据正在变化，请稍后重试');
    const preferred = projection.preferred ? JSON.stringify(projection.preferred) : null;
    if ((old.get(item.file)?.preferred || null) !== preferred) preferencesChanged = true;
    save.run(item.file, item.signature, warning, preferred, projection.label || null, Number.isFinite(projection.stamp) ? projection.stamp : 0);
    dropAuthors.run(item.file);
    if(projection.postAuthors?.length)saveAuthors.run(item.file,JSON.stringify(projection.postAuthors));
    for (const [ordinal, row] of projection.rows.entries()) {
     if (!require('./completeness').exactId(row.recordId)) continue;
     affected.add(row.recordId);
     insert.run(item.file, ordinal, row.recordId, projection.role, Number.isFinite(projection.stamp) ? projection.stamp : 0, projection.savedAt || null, projection.hash || null, JSON.stringify(row));
    }
   }
   for (const [name, previous] of old) if (!current.has(name)) {
    for (const row of ids.all(name)) affected.add(row.id);
    if (previous.preferred) preferencesChanged = true;
    drop.run(name); dropAuthors.run(name); db.prepare('DELETE FROM sources WHERE name=?').run(name);
   }
   if (preferencesChanged) for (const row of db.prepare('SELECT DISTINCT id FROM candidates').all()) affected.add(row.id);
   inject('sources-saved');
   const preferred = Object.assign({}, ...db.prepare('SELECT preferred FROM sources WHERE preferred IS NOT NULL').all().map(item => JSON.parse(item.preferred)));
   const load = db.prepare('SELECT * FROM candidates WHERE id=? ORDER BY source,ordinal');
   const put = db.prepare('INSERT OR REPLACE INTO rows VALUES(?,?,?,?,?)');
   const erase = db.prepare('DELETE FROM rows WHERE id=?');
   for (const recordId of affected) {
    const candidates = load.all(recordId).map(item => ({ ...item, file: item.source, row: JSON.parse(item.row) }));
    erase.run(recordId);
    for (const context of [false, true]) {
     const row = sources.reduce(candidates, dir, id, preferred, context);
     if (!row) continue;
     const body = JSON.stringify(row);
     put.run(recordId, context ? 1 : 0, Number.isFinite(row.ms) ? row.ms : null, body, digest(body));
    }
    stats.rebuiltRows++;
   }
   inject('rows-saved');
   if (sources.manifest(dir, id).signature !== before.signature) throw Error('本地数据正在变化，请稍后重试');
   const write = db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)');
   for (const [key, value] of Object.entries({ owner: id, implementation, signature: before.signature, poolSignature: before.poolSignature, count: String(db.prepare('SELECT count(*) n FROM rows').get().n) })) write.run(key, value);
   db.exec('COMMIT'); stats.rebuilds++;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
 }
 // The selection columns and source contributions are not independent evidence.
 // A seal binds the whole disposable database's file identity after our commit.
 // External SQLite edits therefore invalidate it even if row counts/body hashes
 // still match. Normal unchanged reads cost only two small file-stat operations.
 function validSeal() {
  if (!fs.existsSync(file)) return false;
  try {
   if (!fs.lstatSync(file).isFile()) throw Error('本地显示索引路径无效');
   const box = JSON.parse(require('./regular-file').read(sealFile, { maxBytes: 8192 }).toString('utf8'));
   const { checksum, ...value } = box;
   return value.schema === 1 && value.owner === id && value.implementation === implementation &&
    digest(JSON.stringify(value)) === checksum && value.signature === views.stamp(file)?.signature;
  } catch (error) {
   if (/路径无效/.test(error.message)) throw error;
   return false;
  }
 }
 function seal() {
  const signature = views.stamp(file)?.signature;
  if (validSeal()) return;
  const value = { schema: 1, owner: id, implementation, signature };
  require('./update-progress').atomic(sealFile, { ...value, checksum: digest(JSON.stringify(value)) });
 }
 function withIndex(fn, retry = true) {
  let db, success = false;
  try {
   if (fs.existsSync(file) && !validSeal()) fs.rmSync(file);
   db = open(); sync(db); const result = fn(db); success = true; return result;
  } catch (error) {
   if (retry && /(?:SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database|显示正文校验失败)/i.test(error.code + ' ' + error.message)) {
    db?.close(); db = null; fs.rmSync(file, { force: true }); return withIndex(fn, false);
   }
   throw error;
  } finally { db?.close(); if (success) seal(); }
 }
 function decode(item) {
  if (!item) return null;
  if (digest(item.body) !== item.hash) throw Error('显示正文校验失败');
  stats.selectedRows++;
  return JSON.parse(item.body);
 }
 function select(o, unreadIds = null) {
  return withIndex(db => {
   const from = Number.isFinite(o.startMs) ? o.startMs : -8640000000000000;
   const to = Number.isFinite(o.endMs) ? o.endMs : 8640000000000000;
   const count = Number.isFinite(o.count) ? o.count : -1;
   const where = 'WHERE context=0 AND ms BETWEEN ? AND ?' +
    (unreadIds ? ' AND id IN (SELECT value FROM json_each(?))' : '');
   const bounds = unreadIds ? [from, to, JSON.stringify([...unreadIds])] : [from, to];
   const matched = db.prepare('SELECT count(*) n FROM rows ' + where).get(...bounds).n;
   const rows = db.prepare('SELECT * FROM rows ' + where + ' ORDER BY ms DESC,length(id) DESC,id DESC LIMIT ?').all(...bounds, count).map(decode);
   // Only explicit parents/root references are included; quotes remain context.
   const all = new Map(rows.map(row => [row.recordId, row]));
   const lookup = db.prepare('SELECT * FROM rows WHERE id=? ORDER BY context LIMIT 1');
   for (const row of rows) {
    let parentId = row.replyId || row.rootId;
    for (let n = 0; parentId && n < 3; n++) {
     const parent = all.get(parentId) || decode(lookup.get(parentId));
     if (!parent || parent.postId !== row.postId || parent.ms > row.ms) break;
     all.set(parentId, parent); if (parent.replyId === parentId) break; parentId = parent.replyId;
    }
   }
   const latest = db.prepare('SELECT max(ms) ms FROM rows WHERE context=0').get().ms;
   const label = db.prepare("SELECT label FROM sources WHERE label IS NOT NULL ORDER BY CASE WHEN name LIKE '%/exchange-v1/%' THEN 1 ELSE 0 END,stamp DESC,name LIMIT 1").get()?.label || '未知作者';
   return { rows, all: [...all.values()], matched, latest, label, postAuthors:authors(db), warnings: db.prepare("SELECT warning FROM sources WHERE warning<>''").all().map(item => item.warning) };
  });
 }
 function authors(db){
  return sources.authorEvidence(id,db.prepare('SELECT evidence FROM source_authors ORDER BY name').all().flatMap(item=>JSON.parse(item.evidence)));
 }
 function latestComment() {
  return withIndex(db=>{
   const row=decode(db.prepare('SELECT * FROM rows WHERE context=0 AND ms IS NOT NULL ORDER BY ms DESC,length(id) DESC,id DESC LIMIT 1').get());
   return row?{ms:row.ms,time:row.time,id:row.recordId}:null;
  });
 }
 return { select, latestComment, authors:()=>withIndex(authors), stats, file };
}
module.exports = { create };
