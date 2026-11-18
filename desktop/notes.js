'use strict';
const fs=require('node:fs'),path=require('node:path');
const {readerRoot}=require('../lib/data-layout'),{atomic}=require('../lib/update-progress');
const MAX_LENGTH=2000;
function text(value){
 if(typeof value!=='string')throw Error('备注必须是文字');
 const note=value.replace(/\r\n?/g,'\n');
 if([...note].length>MAX_LENGTH)throw Error('备注最多 '+MAX_LENGTH+' 个字');
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note))throw Error('备注不能包含控制字符');
 return note;
}
function save(base,kind,id,value){
 if(!['user','post'].includes(kind)||typeof id!=='string'||!/^\d{5,20}$/.test(id))throw Error(kind==='post'?'备注需要有效的微博 ID':'备注需要有效的用户 UID');
 const note=text(value),field=kind==='user'?'users':'posts',file=path.join(readerRoot(base),field+'.json');let box;
 try{box=JSON.parse(fs.readFileSync(file));}catch(error){if(error.code!=='ENOENT')throw Error('本地备注设置无法读取，原文件已保留');box={schema:1,[field]:{}};}
 if(box?.schema!==1||!box[field]||typeof box[field]!=='object'||Array.isArray(box[field]))throw Error('本地备注设置格式无效，原文件已保留');
 const found=kind==='user'?require('./library').listAccounts(base).find(u=>u.uid===id):require('./post-workspace').list(base).find(p=>p.postId===id);
 if(!found)throw Error(kind==='user'?'该用户已移除，请重新选择用户':'该博文已移除，请重新选择博文');
 const previous=box[field][id];
 if(previous&&(kind==='user'?previous.uid!==id:previous.postId!==id))throw Error('备注条目身份不匹配，原文件已保留');
 const noteUpdatedAt=new Date().toISOString();box[field][id]={...(previous||found),...(kind==='user'?{uid:id}:{postId:id}),note,noteUpdatedAt};
 atomic(file,box);
 return {...(kind==='user'?{uid:id}:{postId:id}),note,noteUpdatedAt};
}
module.exports={MAX_LENGTH,text,save};
