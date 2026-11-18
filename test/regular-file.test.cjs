'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const R=require('../lib/regular-file'),V=require('../lib/file-view-cache');
test('ordinary local reads reject FIFOs and symlinks instead of blocking the engine',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'reader-regular-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const file=path.join(base,'pipe.json');assert.equal(spawnSync('/usr/bin/mkfifo',[file]).status,0);
 assert.throws(()=>R.read(file),{code:'LOCAL_SOURCE_INVALID'});assert.throws(()=>V.fileView(file,'fixture'),{code:'LOCAL_SOURCE_INVALID'});
 const target=path.join(base,'body.json');fs.writeFileSync(target,'{"saved":true}');const link=path.join(base,'link.json');fs.symlinkSync(target,link);assert.throws(()=>R.read(link),{code:'LOCAL_SOURCE_INVALID'});
 assert.deepEqual(V.readJSON(target),{saved:true});assert.throws(()=>R.read(target,{maxBytes:2}),{code:'LOCAL_SOURCE_INVALID'});
 const dir=path.join(base,'data/post-comments/6000000000011001'),scope='11111111-1111-4111-8111-111111111111',store=require('../lib/legacy-web-evidence').open(dir,{scope,kind:'post-follow',id:'6000000000011001'});
 fs.mkdirSync(store.folder,{recursive:true});assert.equal(spawnSync('/usr/bin/mkfifo',[path.join(store.folder,'progress.json')]).status,0);assert.throws(()=>store.load(),{code:'LOCAL_SOURCE_INVALID'});
});
test('a file replaced with a FIFO between stat and open cannot hang or be read as JSON',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'reader-regular-race-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const file=path.join(base,'body.json');fs.writeFileSync(file,'{}');
 const open=fs.openSync;let changed=false;fs.openSync=function(name,flags,...args){if(name===file&&!changed){changed=true;fs.unlinkSync(file);assert.equal(spawnSync('/usr/bin/mkfifo',[file]).status,0);}return open.call(this,name,flags,...args);};
 try{assert.throws(()=>R.read(file),{code:'LOCAL_SOURCE_INVALID'});}finally{fs.openSync=open;}assert(changed);
});

test('a growing regular source is stopped during bounded reads before excess bytes are allocated',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'reader-growing-source-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const file=path.join(base,'body.json');fs.writeFileSync(file,'1234');const read=fs.readSync,readAll=fs.readFileSync;let grown=false,requested=0;
 fs.readSync=function(fd,buffer,offset,length,...args){requested+=length;if(!grown){grown=true;fs.appendFileSync(file,Buffer.alloc(1024*1024));}return read.call(this,fd,buffer,offset,length,...args);};fs.readFileSync=function(name,...args){if(typeof name==='number')assert.fail('bounded sources cannot use an unbounded descriptor read');return readAll.call(this,name,...args);};
 try{assert.throws(()=>R.read(file,{maxBytes:8}),{code:'LOCAL_SOURCE_INVALID'});assert(requested<=9);}finally{fs.readSync=read;fs.readFileSync=readAll;}
 fs.writeFileSync(file,'12345678');assert.equal(R.read(file,{maxBytes:8}).toString(),'12345678');
});
