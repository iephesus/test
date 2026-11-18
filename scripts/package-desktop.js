#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),info=require('./app-version').appVersion(require('../package.json')),version=info.version,source=process.env.WEIBO_PACKAGE_APP||path.join(root,'dist/Weibo Reader.app');
function run(cmd,args,cwd){const p=spawnSync(cmd,args,{cwd,env:{...process.env,TZ:'UTC'},encoding:'utf8',maxBuffer:1024*1024});if(p.status!==0||p.error)throw Error(p.stderr||p.error?.message||'打包失败');return p.stdout;}
function normalizeTimes(file,stamp){
 const stat=fs.lstatSync(file);
 if(stat.isSymbolicLink()){fs.lutimesSync(file,stamp,stamp);return;}
 if(stat.isDirectory())for(const entry of fs.readdirSync(file))normalizeTimes(path.join(file,entry),stamp);
 fs.utimesSync(file,stamp,stamp);
}
const archiveEpoch=process.env.SOURCE_DATE_EPOCH;
if(archiveEpoch!==undefined&&(!/^\d+$/.test(archiveEpoch)||Number(archiveEpoch)<315532800||Number(archiveEpoch)>4354819199))throw Error('打包时间戳不在 ZIP 支持范围内');
if(process.platform!=='darwin')throw Error('需要 macOS 打包');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-package-')),dist=path.join(root,'dist'),stem='Weibo-Reader';fs.mkdirSync(dist,{recursive:true});
try{
 const volume=path.join(temp,'volume');fs.mkdirSync(volume);
 const app=path.join(volume,'Weibo Reader.app');run('/usr/bin/ditto',['--norsrc','--noextattr','--noacl',source,app]);
 const plist=path.join(app,'Contents/Info.plist'),properties=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',plist]));if(Object.hasOwn(properties,'WeiboDefaultWorkspace'))run('/usr/libexec/PlistBuddy',['-c','Delete :WeiboDefaultWorkspace',plist]);
 for(const [key,wanted]of [['WeiboAppVersion',version],['CFBundleShortVersionString',info.release],['CFBundleVersion',info.build]]){const installed=run('/usr/libexec/PlistBuddy',['-c','Print :'+key,plist]).trim();if(installed!==wanted)throw Error('程序与包版本不一致，请重新构建');}
 for(const name of ['data','output','.reader','.env'])if(fs.existsSync(path.join(app,'Contents/Resources/engine',name)))throw Error('发现个人数据，停止打包');
 run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);run('/usr/bin/codesign',['--verify','--deep','--strict',app]);run(process.execPath,[path.join(__dirname,'audit-release.js'),app]);
 fs.symlinkSync('/Applications',path.join(volume,'Applications'));fs.writeFileSync(path.join(volume,'安装说明.txt'),'Weibo Reader\n\n将 Weibo Reader.app 拖入 Applications 后打开。\nApple Silicon Mac，macOS 13.5 或更新。\n首次运行使用个人资料目录并自行登录服务账户。替换应用不会删除资料库。\n安装包采用 ad hoc 签名，尚未经过 Apple 公证。\n若首次打开时提示无法验证开发者或无法检查 App，请确认来自本仓库并核对 SHA-256。尝试打开后，进入「系统设置 → 隐私与安全性」，在「安全性」下点「仍要打开」，然后确认「打开」。\n');
 if(archiveEpoch!==undefined)normalizeTimes(volume,Number(archiveEpoch));
 const dmg=path.join(dist,stem+'.dmg'),zip=path.join(dist,stem+'.zip'),stagedZip=path.join(temp,'archive.zip');
 const image=path.join(temp,'volume.dmg'),writable=path.join(temp,'writable.dmg'),mount=path.join(temp,'mount');
 // HFS+ reconstruction drops host provenance but generates Finder attributes.
 // Clear those in the private image before compressing and verifying the signed bundle.
 run('/usr/bin/hdiutil',['makehybrid','-hfs','-hfs-volume-name','Weibo Reader','-o',image,volume]);
 run('/usr/bin/hdiutil',['convert',image,'-format','UDRW','-o',writable]);fs.mkdirSync(mount);
 run('/usr/bin/hdiutil',['attach','-quiet','-readwrite','-nobrowse','-noautoopen','-owners','on','-mountpoint',mount,writable]);
 try{
  run('/usr/bin/xattr',['-rcs',mount]);
  run('/usr/bin/codesign',['--verify','--deep','--strict',path.join(mount,path.basename(app))]);
 }finally{run('/usr/bin/hdiutil',['detach','-quiet',mount]);}
 run('/usr/bin/hdiutil',['convert',writable,'-format','UDZO','-ov','-o',dmg]);
 // Retain executable modes and internal symlinks without AppleDouble or host-specific ZIP fields.
 run('/usr/bin/zip',['-X','-q','-r','-y',stagedZip,path.basename(app)],volume);fs.copyFileSync(stagedZip,zip);
 const hashes=[dmg,zip].map(f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')+'  '+path.basename(f));fs.writeFileSync(path.join(dist,stem+'-SHA256SUMS.txt'),hashes.join('\n')+'\n');console.log(JSON.stringify({version,dmg,zip,signature:'ad-hoc; not notarized',runtime:'bundled'}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
