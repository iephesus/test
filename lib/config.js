'use strict';
const path=require('node:path');
const MODES={
  sent:'发出的评论',received:'收到的评论',both:'发出和收到的评论',
  'mentions-comments':'被@的评论','mentions-posts':'被@的微博','post-comments':'微博下的评论','user-posts':'账户微博',all:'全部'
};
const ENDPOINTS={
  'post-comments':{command:['comments','show/all'],label:'微博下的评论'},
  sent:{command:['comments','by_me/other'],label:'发出的评论'},
  received:{command:['comments','to_me/other'],label:'收到的评论'},
  both:{command:['comments','timeline/other'],label:'发出和收到的评论'},
  'mentions-comments':{command:['comments','mentions/other'],label:'被@的评论'},
  'mentions-posts':{command:['statuses','mentions/other'],label:'被@的微博'}
};
// Resolve dependencies and data relative to this project, regardless of the caller's directory.
const BASE=process.env.WEIBO_DESKTOP_PROJECT?path.resolve(process.env.WEIBO_DESKTOP_PROJECT):path.resolve(__dirname,'..');
const COMMANDS={
 'comments-sent':'sent','comments-received':'received','comments-both':'both',
 'mentions-in-comments':'mentions-comments','mentions-in-posts':'mentions-posts',
 'comments-and-mentions':'all','post-comments':'post-comments','user-posts':'user-posts'
};
const commandName=mode=>Object.keys(COMMANDS).find(name=>COMMANDS[name]===mode)||mode;
module.exports={MODES,ENDPOINTS,BASE,COMMANDS,commandName};
