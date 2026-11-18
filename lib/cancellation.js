'use strict';
const fs=require('node:fs');
const cancelled=()=>!!process.env.WEIBO_CANCEL_FILE&&fs.existsSync(process.env.WEIBO_CANCEL_FILE);
function check(){if(cancelled()){let yielded=false;try{const value=JSON.parse(require('./regular-file').read(process.env.WEIBO_CANCEL_FILE,{maxBytes:8192}));yielded=value.schema===1&&value.code==='AUTO_YIELD'&&!!process.env.WEIBO_AUTO_ROUND_ID&&value.roundId===process.env.WEIBO_AUTO_ROUND_ID;}catch{}const e=Error(yielded?'手动任务优先，已保存当前响应和位置；等待手动任务结束后继续订阅':'已中断：已收到的数据与读取进度保留，下次可以继续');e.code=yielded?'AUTO_YIELD':'USER_CANCELLED';throw e;}}
module.exports={cancelled,check};
