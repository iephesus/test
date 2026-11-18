'use strict';
// Shared local post-body selection. No network or acquisition-progress authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const views = require('./file-view-cache');
const E = require('./exchange-records');
const M = require('./exchange-merge');
const { completeBody } = require('./record-body');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function manifest(dir, id) {
 const root = path.join(dir, 'cache');
 const files = views.manifest(root, { children: ['request-journal', 'exchange-v1'], strict: true }).files.filter(item => {
  const name = path.relative(root, item.file).split(path.sep).join('/');
  return require('./inventory-sources').sourceKind(name, { category: 'post-comments', id }) || name === 'exchange-v1/preferred.json';
 });
 const poolSignature = require('./exchange-store').signatureFor(dir);
 return { files, poolSignature, signature: digest(files.map(item => item.file + '\0' + item.signature).join('\n') + '|' + poolSignature) };
}
function project(item, dir, id) {
 const relative = path.relative(path.join(dir, 'cache'), item.file).split(path.sep).join('/');
 const role = require('./inventory-sources').sourceKind(relative, { category: 'post-comments', id });
 const bytes = require('./regular-file').read(item.file), raw = JSON.parse(bytes);
 if (relative === 'exchange-v1/preferred.json') return { preferred: raw.records || {}, rows: [], stamp: 0, role: 'preferred' };
 if (role === 'exchange') {
  const actual = require('./exchange-store').isReference(raw) ? E.bytes(item.file) : bytes;
  const hash = path.basename(item.file, '.json');
  if (digest(actual) !== hash) throw Error('导入内容哈希损坏');
  const value = JSON.parse(actual);
  const accepted = value.owner?.kind === 'post' && value.owner.id === id && value.channel === 'post-comments' && ['packet', 'records'].includes(value.role);
  const parsed = accepted && value.role === 'packet' ? require('./post-comments').postPageRows(value.response, id) : null;
  const rows = accepted ? E.rowsOf(value).map(row => require('./exchange-schema').row(row, 'post-comments')) : [];
  return { label: require('./core').userName(parsed?.source.user) || '', role, stamp: Date.parse(value.savedAt) || 0, rows, postAuthors: authorEvidence(id,[...(parsed?.postAuthors||[]),...rows]), savedAt: value.savedAt, hash };
 }
 let response = raw, stamp = item.mtimeMs;
 if (role === 'receipt') {
  if (raw.schema !== 1 || raw.query?.kind !== 'post-comments' || raw.query.uid !== id) return { role, stamp: 0, rows: [] };
  response = raw.response; stamp = Date.parse(raw.savedAt);
 }
 const parsed = require('./core').apiError(response) ? { rows: [], source: {} } : require('./post-comments').postPageRows(response, id);
 const rows = parsed.rows.filter(row => row.recordId && completeBody(row));
 return { role, stamp, rows, label: require('./core').userName(parsed.source.user) || '', postAuthors:authorEvidence(id,parsed.postAuthors) };
}
function authorEvidence(id,rows=[]){
 const authors=new Map(),exact=require('./completeness').exactId;
 for(const row of rows)if(row.postId===id&&exact(row.postAuthorUid)===row.postAuthorUid&&row.postAuthorUid){
  if(!authors.get(row.postAuthorUid)?.postAuthor)authors.set(row.postAuthorUid,{postId:id,postAuthorUid:row.postAuthorUid,postAuthor:row.postAuthor||''});
 }
 return [...authors.values()];
}
function reduce(candidates, dir, id, preferred = {}, contexts = false) {
 let selected = null;
 const imported = [];
 for (const candidate of candidates) {
  const { row, role, stamp, file, hash, savedAt } = candidate;
  if (role === 'exchange') {
   imported.push({ file, hash, value: { role: 'records', owner: { kind: 'post', id }, channel: 'post-comments', savedAt, rows: [row] } });
  } else if (!contexts && completeBody(row)) {
   if (!selected) selected = { row, stamp };
   else {
    const incoming = { row, stamp }, main = selected.stamp <= stamp ? incoming : selected;
    selected = { ...main, row: M.merge(main.row, main === incoming ? selected.row : row, 'post-comments') };
   }
  }
 }
 const versions = E.versionsFromEntries(imported, dir, 'post-comments', id);
 const supplement = E.selectVersions(versions, preferred, 'post-comments', contexts).values().next().value;
 return selected ? M.merge(selected.row, supplement?.row, 'post-comments') : supplement?.row;
}
module.exports = { manifest, project, reduce, digest, authorEvidence };
