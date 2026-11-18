'use strict';
// Presentation only: keep the existing date inputs and their captured task values.
(()=>{
 const controls=[];
 for(const input of document.querySelectorAll('input[type="date"]')){
  const field=input.closest('.field');if(!field)continue;
  const start=['from','coverage-from','global-search-from'].includes(input.id),label=field.querySelector('label'),row=node('div','date-bound-label'),shell=node('div','date-input-shell'),empty=node('span','date-empty-label',start?'不限起始日期':'不限截止日期');
  const clear=button('不限','button secondary date-clear',()=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));refresh();});
  clear.type='button';clear.setAttribute('aria-label',(start?'起始日期':'截止日期')+'设为不限');
  label.replaceWith(row);row.append(label,clear);input.replaceWith(shell);shell.append(input,empty);
  const hint=node('span','date-bound-note');hint.id=input.id+'-boundary-note';field.append(hint);input.setAttribute('aria-describedby',hint.id);
  input.addEventListener('input',refresh);input.addEventListener('change',refresh);controls.push({input,clear,shell,hint,start});
 }
 function refresh(){for(const {input,clear,shell,hint,start} of controls){const filled=!!input.value;shell.classList.toggle('date-is-empty',!filled);clear.disabled=!filled;clear.textContent=filled?'设为不限':'已不限';hint.textContent=filled?(start?'包含当天，从 00:00 开始':'包含当天，至 23:59:59 结束'):(start?'不限制最早日期':'不限制最晚日期');}}
 window.ReaderDateControls={refresh};refresh();
})();
