'use strict';
const fs=require('node:fs'),path=require('node:path');
const {BASE}=require('./config');
function canonical(file){const tail=[];let current=path.resolve(file);while(!fs.existsSync(current)&&path.dirname(current)!==current){tail.unshift(path.basename(current));current=path.dirname(current);}return path.join(fs.realpathSync(current),...tail);}
const categories=['user-comments','post-comments','posts'];
const separated=(base=BASE)=>fs.existsSync(path.join(base,'data/.layout-v2'));
const readerRoot=(base=BASE)=>path.join(base,separated(base)?'data':'output','.reader');
function reportPath(dir,base=BASE){
 const relative=path.relative(canonical(path.join(base,'data')),canonical(dir)).split(path.sep);
 if(!separated(base)||relative.length!==2||!categories.includes(relative[0])||relative[1]==='..')return dir;
 return path.join(base,'output',...relative);
}
function reportDir(dir,base=BASE){const folder=reportPath(dir,base);if(folder!==dir)fs.mkdirSync(folder,{recursive:true});return folder;}
function dataForReport(base,dir){const relative=path.relative(canonical(path.join(base,'output')),canonical(dir)).split(path.sep);return separated(base)&&relative.length===2&&categories.includes(relative[0])?path.join(base,'data',...relative):dir;}
function mirrorImages(dir,base=BASE){const destination=reportDir(dir,base),images=path.join(dir,'images');if(destination===dir||!fs.existsSync(images))return;fs.mkdirSync(path.join(destination,'images'),{recursive:true});for(const entry of fs.readdirSync(images,{withFileTypes:true})){if(!entry.isFile())continue;const file=path.join(destination,'images',entry.name);if(!fs.existsSync(file))fs.copyFileSync(path.join(images,entry.name),file);}}
function migrate(base){
 if(separated(base))return {moved:0,separated:true};
 const {prepareOutputLayout,mergeStoredPath}=require('./storage'),pending=path.join(base,'data/.layout-migrating');if(!fs.existsSync(pending))prepareOutputLayout(base);const report={moves:[],conflicts:[],duplicates:0};
 const data=path.join(base,'data');fs.mkdirSync(data,{recursive:true});fs.writeFileSync(pending,'2');
 for(const category of categories){const source=path.join(base,'output',category),target=path.join(data,category);fs.mkdirSync(target,{recursive:true});if(!fs.existsSync(source))continue;
  for(const item of fs.readdirSync(source,{withFileTypes:true})){
   if(item.name==='.account_names.json'){mergeStoredPath(path.join(source,item.name),path.join(target,item.name),report);continue;}
   if(!item.isDirectory()||item.isSymbolicLink())continue;const from=path.join(source,item.name),to=path.join(target,item.name);fs.mkdirSync(to,{recursive:true});
   for(const entry of fs.readdirSync(from,{withFileTypes:true})){if(entry.name.endsWith('.html')||entry.name==='images')continue;mergeStoredPath(path.join(from,entry.name),path.join(to,entry.name),report);}
   if(fs.existsSync(path.join(from,'images')))fs.cpSync(path.join(from,'images'),path.join(to,'images'),{recursive:true,errorOnExist:false,force:false});
  }
 }
 const oldSettings=path.join(base,'output/.reader');if(fs.existsSync(oldSettings))mergeStoredPath(oldSettings,path.join(data,'.reader'),report);
 fs.writeFileSync(path.join(data,'.layout-v2'),JSON.stringify({schema:2,migratedAt:new Date().toISOString(),conflicts:report.conflicts}));fs.unlinkSync(pending);return {moved:report.moves.length,separated:true};
}
module.exports={canonical,separated,readerRoot,reportPath,reportDir,dataForReport,mirrorImages,migrate};
