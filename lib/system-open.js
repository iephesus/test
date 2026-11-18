'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {spawn,spawnSync}=require('node:child_process');
const {BASE}=require('./config');
const LIFETIME=24*60*60*1000;
function registryDirectory(){return path.join(os.tmpdir(),'weibo-open-'+(process.getuid?.()??'user')+'-'+crypto.createHash('sha256').update(BASE).digest('hex').slice(0,16));}
function protectedDirectory(dir){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const stat=fs.lstatSync(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid()))throw Error('本地打开入口的目录不可用');
 fs.chmodSync(dir,0o700);
}
function readState(dir){try{const value=JSON.parse(require('./regular-file').read(path.join(dir,'server.json'),{maxBytes:4096}));if(!Number.isSafeInteger(value.pid)||value.pid<1||!Number.isInteger(value.port)||value.port<1||value.port>65535)return null;process.kill(value.pid,0);return value;}catch(error){if(error.code==='LOCAL_SOURCE_INVALID')throw error;return null;}}
function getSystemLinks(file,dependencies={}){
 const absolute=fs.realpathSync(file);if(!/\.html?$/i.test(absolute)||!fs.statSync(absolute).isFile())throw Error('报告文件不存在');
 const dir=dependencies.registryDir||registryDirectory();protectedDirectory(dir);
 let state=readState(dir);
 if(!state){
  const lock=path.join(dir,'start.lock');let owned=false;
  try{try{const fd=fs.openSync(lock,'wx',0o600);fs.closeSync(fd);owned=true;}catch(error){if(error.code!=='EEXIST')throw error;if(Date.now()-fs.statSync(lock).mtimeMs>5000){fs.unlinkSync(lock);const fd=fs.openSync(lock,'wx',0o600);fs.closeSync(fd);owned=true;}}
   if(owned){const child=spawn(process.execPath,[__filename,'serve',dir],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:process.env.LANG||'en_US.UTF-8',TMPDIR:os.tmpdir()}});child.on('error',()=>{});child.unref();}
   const until=Date.now()+2500,pause=new Int32Array(new SharedArrayBuffer(4));
   while(Date.now()<until){state=readState(dir);if(state)break;Atomics.wait(pause,0,0,25);}
  }finally{if(owned&&fs.existsSync(lock))fs.unlinkSync(lock);}
 }
 if(!state)throw Error('本地打开入口未启动，请使用备用命令');
 const token=crypto.randomBytes(32).toString('hex');fs.writeFileSync(path.join(dir,token+'.json'),JSON.stringify({file:absolute,expires:Date.now()+LIFETIME}),{mode:0o600});
 const origin='http://127.0.0.1:'+state.port;
 return {report:origin+'/open/'+token+'/report',folder:origin+'/open/'+token+'/folder',view:origin+'/view/'+token+'/report.html',pid:state.pid,registryDir:dir};
}
function createReportServer(dir,dependencies={}){
 const launch=dependencies.launch||spawnSync,now=dependencies.now||Date.now;let touched=now();
 const server=http.createServer((req,res)=>{
  const origin='http://127.0.0.1:'+server.address().port;
  function reply(status,message){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(message);}
  if(req.method!=='GET')return reply(405,'仅支持打开链接');
  if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin))return reply(403,'入口无效');
  let url;try{url=new URL(req.url,origin);}catch{return reply(400,'入口无效');}
  if(url.origin!==origin)return reply(403,'入口无效');
  const match=url.pathname.match(/^\/(open|view)\/([a-f0-9]{64})\/(.+)$/);if(!match)return reply(404,'入口无效或已过期，请使用终端备用命令');
  const [,mode,token,resource]=match;let record;
  try{const entry=path.join(dir,token+'.json');record=JSON.parse(require('./regular-file').read(entry,{maxBytes:65536}));if(!Number.isFinite(record.expires)||record.expires<now()||!path.isAbsolute(record.file)||!/\.html?$/i.test(record.file))throw Error();}catch{return reply(404,'入口无效或已过期，请使用终端备用命令');}
  touched=now();
  if(mode==='open'){
   if(!['report','folder'].includes(resource))return reply(404,'入口无效');
   if(req.headers.purpose||req.headers['sec-purpose']||(req.headers['sec-fetch-dest']&&!['document','empty'].includes(req.headers['sec-fetch-dest'])))return reply(403,'请直接点击终端入口');
   let result;try{const target=resource==='report'?origin+'/view/'+token+'/report.html':fs.realpathSync(path.dirname(record.file));const args=resource==='folder'?['-a','Finder',target]:[target];result=launch('/usr/bin/open',args,{shell:false,stdio:'ignore',timeout:10000});}catch{return reply(500,'系统打开失败，请使用终端备用命令');}
   if(result?.error||result?.status!==0)return reply(500,'系统打开失败，请使用终端备用命令');
   res.writeHead(204,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
  }
  let file=record.file,type='text/html; charset=utf-8';
  if(resource!=='report.html'){
   let relative;try{relative=decodeURIComponent(resource);}catch{return reply(400,'文件地址无效');}
   if(!relative.startsWith('images/')||relative.includes('\\')||relative.includes('\0')||relative.split('/').some(part=>part==='..'||part==='.'))return reply(404,'文件不存在');
   try{const folder=fs.realpathSync(path.dirname(record.file));file=fs.realpathSync(path.join(folder,relative));if(!file.startsWith(folder+path.sep)||!fs.statSync(file).isFile())throw Error();}catch{return reply(404,'文件不存在');}
   type={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif'}[path.extname(file).toLowerCase()];if(!type)return reply(404,'文件不存在');
  }
  let fd,stat;try{fd=require('./regular-file').open(file);stat=fs.fstatSync(fd);}catch{if(fd!=null)fs.closeSync(fd);return reply(404,'文件不存在或已变化');}
  res.writeHead(200,{'Content-Type':type,'Content-Length':stat.size,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Cross-Origin-Resource-Policy':'same-origin'});
  if(!stat.size){fs.closeSync(fd);return res.end();}
  const stream=fs.createReadStream(file,{fd,autoClose:true,start:0,end:stat.size-1});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
 });
 const timer=setInterval(()=>{if(now()-touched>(dependencies.idleMs??LIFETIME))server.close();},60000);timer.unref();
 server.on('close',()=>clearInterval(timer));return server;
}
function serve(dir){
 protectedDirectory(dir);const server=createReportServer(dir);
 server.on('error',()=>process.exitCode=1);
 server.listen(0,'127.0.0.1',()=>{const file=path.join(dir,'server.json'),temp=file+'.'+process.pid;fs.writeFileSync(temp,JSON.stringify({pid:process.pid,port:server.address().port}),{mode:0o600});fs.renameSync(temp,file);});
 const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);
 server.on('close',()=>{try{const state=JSON.parse(require('./regular-file').read(path.join(dir,'server.json'),{maxBytes:4096}));if(state.pid===process.pid)fs.unlinkSync(path.join(dir,'server.json'));}catch{}});
}
if(require.main===module&&process.argv[2]==='serve')serve(process.argv[3]);
module.exports={getSystemLinks,createReportServer,registryDirectory};

// Resolve the HTTPS handler without opening a URL or consulting HTML-file associations.
function defaultBrowser({execFileSync=require('node:child_process').execFileSync}={}){
 const script='ObjC.import("AppKit"); const app=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://weibo.com/")); if(!app) throw Error("No default browser"); ObjC.unwrap(app.path);';
 const value=execFileSync('/usr/bin/osascript',['-l','JavaScript','-e',script],{encoding:'utf8',timeout:5000}).trim();
 if(!path.isAbsolute(value)||!value.endsWith('.app')||/[\r\n\0]/.test(value))throw Error('无法确定系统默认浏览器');return value;
}
module.exports.defaultBrowser=defaultBrowser;
