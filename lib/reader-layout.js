'use strict';
// Presentation groups do not establish parent IDs or acquisition continuity.
// Keep unlinked comments in one chronological stream, even in branch mode.
function layoutConversation(body,messages,mode,dayLabel){
 const fragment=document.createDocumentFragment(),groups=new Map();
 for(const message of messages){
  // Previously generated cards keep the original prefix in their details.
  // Add its display-only recipient without changing stored rows or IDs.
  const details=message.querySelector('.record-details-body'),list=details?.querySelector('dl');
  const recipient=typeof replyPrefixParts==='function'?replyPrefixParts(details?.querySelector('.context-text p')?.textContent||'')?.name:'';
  if(recipient&&list&&![...list.querySelectorAll('dt')].some(n=>n.textContent==='回复对象')){const entry=document.createElement('div'),term=document.createElement('dt'),value=document.createElement('dd');term.textContent='回复对象';value.textContent=recipient;entry.append(term,value);list.append(entry);}
  const root=message.dataset.branchRoot||'';
  const key=mode==='branches'&&root?'root:'+root:'unlinked';
  if(!groups.has(key))groups.set(key,{root:mode==='branches'?root:'',messages:[]});
  groups.get(key).messages.push(message);
 }
 for(const group of groups.values()){
  const section=document.createElement('section');section.className='conversation-branch'+(group.root?'':' conversation-unlinked');section.setAttribute('data-branch-group','');
  if(group.root&&!group.messages.some(m=>m.dataset.commentId===group.root)){
   const note=document.createElement('p');note.className='branch-context-note';note.textContent='本组未包含根评论；以下为已取得的回复。';section.append(note);
  }
  let previous='';
  for(const message of group.messages){
   const day=message.dataset.messageDay||'未知日期';
   if(day!==previous){const divider=document.createElement('div'),label=document.createElement('span');divider.className='day-divider';divider.setAttribute('data-day-group','');label.dataset.day=day;label.textContent=dayLabel(day);divider.append(label);section.append(divider);previous=day;}
   message.classList.toggle('branch-reply',!!group.root&&message.dataset.commentId!==group.root);section.append(message);
  }
  fragment.append(section);
 }
 body.replaceChildren(fragment);
}
module.exports={layoutConversation};
