'use strict';
function recordKey(r){return `${r.group==='mentions-posts'?'post':'comment'}:${r.recordId||[r.authorUid,r.time,r.postId,r.content].join('/')}`;}
module.exports={recordKey};
