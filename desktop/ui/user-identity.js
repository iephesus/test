(function(root){
 'use strict';const ux=typeof module!=='undefined'&&module.exports?require('./form-utils'):root.ReaderUX;
 function selectUser(state,value){const uid=ux.uid(value);if(!uid)throw Error('请选择有效的用户 UID');state.selection=Object.freeze({kind:'user',uid});return uid;}
 function selectPost(state,value=''){const target=String(value).trim();state.selection=Object.freeze({kind:'post',target});return target;}
 function user(state){return state.selection?.kind==='user'?state.selection.uid:'';}
 function target(state){return state.category==='post'?(state.selection?.kind==='post'?state.selection.target:''):user(state);}
 function subject(state){return state.category==='post'?{kind:'post',id:ux.postId(target(state))}:{kind:'user',uid:user(state)};}
 function desktopMode(value){return ['comments-sent','comments-received','comments-both','mentions-in-comments','mentions-in-posts'].includes(value)?value:'comments-both';}
 const api={selectUser,selectPost,user,target,subject,desktopMode};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ReaderIdentity=api;
})(globalThis);
