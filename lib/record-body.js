'use strict';
function completeBody(row,raw=null){
 if(!row||row.isContext||row.truncated||row.bodyMissing||row.contentMissing||!Number.isFinite(row.ms)||(!String(row.content||'').trim()&&!require('./record-quality').media(row)))return false;
 if(raw&&(raw.deleted||raw.unavailable||raw.bodyMissing||raw.contentMissing||raw.isContext||((raw.truncated||raw.isLongText||raw.is_long_text)&&require('./record-quality').expanded(raw)==null)))return false;
 return true;
}
module.exports={completeBody};
