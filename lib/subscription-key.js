'use strict';
// Keep persisted UID-era entries compatible, without conflating equal user/post numbers.
function kind(value){return value?.targetKind==='post'?'post':'user';}
function key(value){return kind(value)+':'+String(value?.postId||value?.uid||'');}
function matches(entry,value){return key(entry)===(typeof value==='string'?(value.includes(':')?value:'user:'+value):key(value));}
module.exports={kind,key,matches};
