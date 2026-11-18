'use strict';

const fs=require('node:fs'),path=require('node:path');

const roots=['lib','desktop','node_modules','weibo_cli.js','package.json','weibo_reader_user_guide.md'];
const omitted=[
 'desktop/licenses', // The selected Node license ships under Resources/.
 'desktop/post-ownership.js', // The report renderer already embeds this script.
 'node_modules/pngjs/browser.js', // qrcode loads pngjs through lib/png.js.
 'node_modules/pngjs/coverage',
 // Keep the bundled runtime focused on executable files and required notices.
 'node_modules/pngjs/README.md',
 'node_modules/cliui/CHANGELOG.md',
 'node_modules/yargs-parser/CHANGELOG.md',
 'node_modules/yargs/CHANGELOG.md'
].map(file=>file.split('/').join(path.sep));

function privateName(name){
 return /^(?:\.env(?:\..*)?|auth\.json|credentials\.json|crawler-session\.json|legacy-cookie-migration\.json|tokens\.json|identity\.json|follow-inbox\.json|server\.json|\.DS_Store|\.cookie-.*\.tmp)$/.test(name)||/\.(?:wrdpack|pem|p12|pfx)$/.test(name);
}

function includes(relative){
 const parts=relative.split(path.sep);
 return roots.includes(parts[0])&&!parts.some(privateName)&&!omitted.some(file=>relative===file||relative.startsWith(file+path.sep));
}

function copyPayload(root,engine){
 // Reused build directories must lose retired entrypoints and excluded children.
 for(const name of ['weibo-cli.js','weibo_cli_user_guide.md'])fs.rmSync(path.join(engine,name),{force:true});
 for(const item of roots){
  const source=path.join(root,item),target=path.join(engine,item);
  if(!fs.existsSync(source))throw Error('缺少构建文件：'+item);
  fs.rmSync(target,{recursive:true,force:true});
  fs.cpSync(source,target,{recursive:true,verbatimSymlinks:true,filter:file=>includes(path.relative(root,file))});
 }
}

module.exports={copyPayload,includes,privateName};
