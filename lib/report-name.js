'use strict';
// File presentation only: exact owner identity remains in its directory/catalog.
const fs=require('node:fs'),path=require('node:path');
const VERSION=2,MAX_LEAF_BYTES=240;
const labels={sent:'本人留言',received:'他人留言',both:'互动',all:'互动与提及','mentions-comments':'评论中的提及','mentions-posts':'微博中的提及','post-comments':'微博评论','user-posts':'微博'};
function clip(text,bytes){let result='';for(const char of text){if(Buffer.byteLength(result+char)>bytes)break;result+=char;}return result.replace(/[. ]+$/g,'');}
function fileName(label,o,count,at=new Date()){
 if(!Number.isSafeInteger(count)||count<0)throw Error('报告条数无效');
 const date=new Date(at);if(!Number.isFinite(date.getTime()))throw Error('报告生成日期无效');
 const kind=labels[o.mode]||'记录',suffix='_'+kind+'_'+require('./date-range').dayOf(date.getTime())+'_'+count+'条.html';
 const clean=require('./core').safeName(label)||require('./core').safeName(o.postId||o.uid)||'报告';
 const name=clip(clean.replace(/^\.+/,''),MAX_LEAF_BYTES-Buffer.byteLength(suffix))||'报告';
 return name+suffix;
}
function numbered(file,sequence){if(sequence===1)return file;const extension=path.extname(file);return file.slice(0,-extension.length)+'-'+sequence+extension;}
function writeExclusive(first,html){for(let sequence=1;sequence<=10000;sequence++){const file=numbered(first,sequence);try{fs.writeFileSync(file,html,{flag:'wx'});return file;}catch(error){if(error.code!=='EEXIST')throw error;}}throw Error('同名报告过多，原文件已保留');}
function parse(name){const match=/_(本人留言|他人留言|互动与提及|互动|评论中的提及|微博中的提及|微博评论|微博)_(\d{4}-\d{2}-\d{2})_(\d+)条(?:-([2-9]\d*|1\d+))?\.html$/.exec(name);if(!match||!Number.isSafeInteger(Number(match[3])))return null;const date=new Date(match[2]+'T00:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==match[2])return null;return {mode:Object.keys(labels).find(mode=>labels[mode]===match[1]),label:match[1],date:match[2],count:Number(match[3])};}
module.exports={VERSION,MAX_LEAF_BYTES,fileName,numbered,writeExclusive,parse};
