'use strict';
const fs=require('node:fs');
const enabled=()=>process.env.WEIBO_DESKTOP_EVENTS==='1';
function emit(type,data={}){if(!enabled())return;try{fs.writeSync(3,JSON.stringify({type,...data})+'\n');}catch{}}
module.exports={emit,enabled};
