#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),APP=process.env.WEIBO_DESKTOP_BUILD_PATH||path.join(ROOT,'dist','Weibo Reader.app');
if(!path.isAbsolute(APP)||!APP.endsWith('.app'))throw Error('桌面构建输出必须是绝对 .app 路径');
function run(command,args){const result=spawnSync(command,args,{cwd:ROOT,encoding:'utf8',maxBuffer:5*1024*1024});if(result.status!==0||result.error)throw Error((result.stderr||result.stdout||result.error?.message||'执行失败').trim());return result.stdout.trim();}
function xml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
if(process.platform!=='darwin')throw Error('当前桌面包使用 macOS AppKit / WebKit，请在 macOS 上构建');
const versionInfo=require('./app-version').appVersion(JSON.parse(fs.readFileSync(path.join(ROOT,'package.json')))),VERSION=versionInfo.version;
if(process.arch!=='arm64')throw Error('请使用 Apple Silicon 版 Node.js 构建');
const arch='arm64';
const nodeLicense=path.join(ROOT,'desktop/licenses',process.version+'-Node-LICENSE.txt');if(!fs.existsSync(nodeLicense))throw Error('请先将当前 Node '+process.version+' 的官方 LICENSE 保存到 '+nodeLicense);
const contents=path.join(APP,'Contents'),resources=path.join(contents,'Resources'),engine=path.join(resources,'engine'),bin=path.join(contents,'MacOS'),runtime=path.join(resources,'runtime/bin');
fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(engine,{recursive:true});
require('./desktop-payload').copyPayload(ROOT,engine);
const node=path.join(runtime,'node');
const architectures=run('/usr/bin/lipo',['-archs',process.execPath]).split(/\s+/);
if(architectures.length>1)run('/usr/bin/lipo',[process.execPath,'-thin',arch,'-output',node]);else if(architectures.includes(arch))fs.copyFileSync(process.execPath,node);else throw Error('Node 运行环境架构不匹配');fs.chmodSync(node,0o755);
const executable=path.join(bin,'WeiboReader');
console.log('编译 macOS 窗口（'+arch+'）…');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-reader-build-'));
try{
 run('/usr/bin/xcrun',['swiftc','-swift-version','5','-O','-file-prefix-map',ROOT+'=.','-target',arch+'-apple-macosx13.5','-module-cache-path',path.join(temporary,'modules'),'-framework','AppKit','-framework','WebKit',path.join(ROOT,'desktop/WeiboReader.swift'),path.join(ROOT,'desktop/ExternalLinks.swift'),path.join(ROOT,'desktop/FeedbackDiagnostics.swift'),'-o',executable]);
 const iconSet=path.join(temporary,'Reader.iconset');fs.mkdirSync(iconSet);
 const iconSource=`import AppKit\nlet folder=CommandLine.arguments[1]\nfor n in [16,32,128,256,512] { for scale in [1,2] { let size=n*scale;let image=NSImage(size:NSSize(width:size,height:size));image.lockFocus();NSColor(calibratedRed:0.19,green:0.36,blue:0.90,alpha:1).setFill();let unit=CGFloat(size)/1024;NSBezierPath(roundedRect:NSRect(x:24*unit,y:24*unit,width:976*unit,height:976*unit),xRadius:220*unit,yRadius:220*unit).fill();NSColor.white.setFill();let bubble=NSBezierPath();bubble.move(to:NSPoint(x:238*unit,y:725*unit));bubble.line(to:NSPoint(x:788*unit,y:725*unit));bubble.line(to:NSPoint(x:788*unit,y:359*unit));bubble.line(to:NSPoint(x:438*unit,y:359*unit));bubble.line(to:NSPoint(x:238*unit,y:209*unit));bubble.close();bubble.fill();NSColor(calibratedRed:0.19,green:0.36,blue:0.90,alpha:1).setStroke();let lines=NSBezierPath();lines.lineWidth=40*unit;lines.lineCapStyle = .round;lines.move(to:NSPoint(x:355*unit,y:586*unit));lines.line(to:NSPoint(x:674*unit,y:586*unit));lines.move(to:NSPoint(x:355*unit,y:477*unit));lines.line(to:NSPoint(x:557*unit,y:477*unit));lines.stroke();image.unlockFocus();let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!;let png=bitmap.representation(using:.png,properties:[:])!;let name="icon_\\(n)x\\(n)"+(scale==2 ? "@2x" : "")+".png";try png.write(to:URL(fileURLWithPath:folder).appendingPathComponent(name));} }`;
 const source=path.join(temporary,'icon.swift');fs.writeFileSync(source,iconSource);
 run('/usr/bin/xcrun',['swift','-module-cache-path',path.join(temporary,'modules'),source,iconSet]);
 run('/usr/bin/iconutil',['-c','icns',iconSet,'-o',path.join(resources,'Reader.icns')]);
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Weibo Reader</string><key>CFBundleDisplayName</key><string>Weibo Reader</string><key>CFBundleIdentifier</key><string>selnokk.weibo.reader</string><key>CFBundleVersion</key><string>${versionInfo.build}</string><key>CFBundleShortVersionString</key><string>${xml(versionInfo.release)}</string><key>WeiboAppVersion</key><string>${xml(VERSION)}</string><key>CFBundleGetInfoString</key><string>Weibo Reader</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>WeiboReader</string><key>CFBundleIconFile</key><string>Reader</string><key>LSMinimumSystemVersion</key><string>13.5</string><key>NSHighResolutionCapable</key><true/><key>NSHumanReadableCopyright</key><string>selnokk</string></dict></plist>`;
fs.copyFileSync(path.join(ROOT,'LICENSE'),path.join(resources,'LICENSE.txt'));
fs.copyFileSync(nodeLicense,path.join(resources,'Node-LICENSE.txt'));
fs.writeFileSync(path.join(resources,'THIRD_PARTY_NOTICES.txt'),'Bundled Node.js '+process.version+': see Node-LICENSE.txt.\nWeiboCLI, parse5 (MIT), entities and their dependencies: see licenses under engine/node_modules/.\nNo reports, caches or login credentials are included in this application.\n');
fs.writeFileSync(path.join(contents,'Info.plist'),plist);fs.writeFileSync(path.join(contents,'PkgInfo'),'APPL????');
run('/usr/bin/codesign',['--force','--sign','-',node]);run('/usr/bin/codesign',['--force','--deep','--sign','-',APP]);run('/usr/bin/codesign',['--verify','--deep','--strict',APP]);
console.log('已生成：'+APP);console.log('内置 Node 与采集依赖；报告和登录凭据未打包。');
