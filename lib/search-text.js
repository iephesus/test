'use strict';
// Generated identity placeholders are metadata, not names or keyword content.
function searchableName(value, uid) {
 const name=String(value||'').trim(), id=String(uid||'');
 return id&&[id,'用户'+id,'用户 '+id,'UID '+id,'UID'+id].includes(name)?'':name;
}
module.exports={searchableName};
