'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),S=require('./exchange-schema'),sync=require('./fs-sync');
function atomicBytes(file, bytes) {
 const tmp = file + '.' + crypto.randomUUID() + '.tmp';
 fs.mkdirSync(path.dirname(file), { recursive: true });
 let fd;
 try {
  fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, bytes); sync.file(fd); fs.closeSync(fd); fd = null;
  fs.renameSync(tmp, file);
  sync.directory(path.dirname(file));
 } finally { if (fd != null) fs.closeSync(fd); fs.rmSync(tmp, { force: true }); }
 return S.hash(bytes);
}
function atomic(file, value) { return atomicBytes(file, Buffer.from(S.stable(value))); }
module.exports={atomic,atomicBytes};
