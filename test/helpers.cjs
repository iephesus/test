const fs=require('node:fs'),path=require('node:path');
function copyProject(dest,{reportParser=false}={}){const root=path.resolve(__dirname,'..');fs.mkdirSync(dest,{recursive:true});for(const name of ['weibo_cli.js','package.json'])fs.copyFileSync(path.join(root,name),path.join(dest,name));fs.cpSync(path.join(root,'lib'),path.join(dest,'lib'),{recursive:true});
 // The report engine needs its installed HTML parser, while each fixture
 // continues to supply its own simulated service CLI.
 if(!reportParser)return;
 const modules=path.join(dest,'node_modules');
 fs.mkdirSync(modules,{recursive:true});
 fs.symlinkSync(path.join(root,'node_modules','parse5'),path.join(modules,'parse5'),'dir');
}
module.exports={copyProject};
