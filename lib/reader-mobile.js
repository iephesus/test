'use strict';
// Presentation only: keep the existing table, exact IDs, counts and filter
// handlers. Labels follow its actual headers, including ownership rebuilds.
const VERSION='2';
const STYLE=`
@media(max-width:900px){
 h1,.subtitle{overflow-wrap:anywhere}
 h1{line-height:1.4;margin-bottom:8px}
 .subtitle{margin-bottom:16px}
 .panel{box-shadow:none;border-color:#e5eaf2}
 .panel:not(.ranking){border-color:transparent;background:transparent}
 .toolbar{gap:8px;padding:12px;background:#fff;border:1px solid #e3eaf2;border-radius:12px}
 .toolbar input,.toolbar select,.toolbar button{border-color:#e1e7f0;border-radius:8px}
 .toolbar input{min-width:0;min-height:42px;flex:1 1 100%}
 .toolbar select{min-width:0;min-height:40px;flex:1 1 calc(50% - 4px);max-width:100%}
 .toolbar #peer{flex-basis:100%}
 .toolbar #clear{min-height:40px;background:transparent;border-color:transparent;color:#526d8d}
 .toolbar .counter{margin-left:auto;color:#6b7e96}
 .toolbar .view-switch{width:100%;background:#edf2f8}
 .toolbar .view-switch button{flex:1;min-height:36px}
 .toolbar .view-switch button[aria-selected="true"]{box-shadow:0 1px 3px #17233814}
 .dialog-tools{gap:6px;margin-bottom:12px}
 .dialog-tools button{min-height:36px;padding:8px 9px;border-color:#e2e8f1;background:#f8fafc;color:#526a89}
 .dialog-order-switch{border-color:transparent;background:#edf2f8}
 .dialog-tools .dialog-order-switch button[aria-pressed="true"]{box-shadow:0 1px 3px #17233814}
 .post-group{border-color:#e3eaf2;border-radius:12px;background:#fff;margin-bottom:12px}
 .post-group>.post-heading{background:#f7f9fc}
 .post-origin-line .source-post-link{background:#edf3fb;border-color:transparent}
 .post-origin-line>.copy-id{background:transparent;border-color:transparent;color:#526e8d}
 .post-heading-badges .post-count{border-color:transparent;background:#edf2f8}
 .bubble-meta .message-author{font-size:13px;min-width:0;max-width:100%;overflow-wrap:anywhere}
 .ranking{margin-bottom:16px}
 .ranking .ranking-heading>*{min-width:0;max-width:100%}
 .ranking .ranking-heading{flex-direction:row;flex-wrap:wrap;gap:8px;padding:12px 14px}
 .ranking .ranking-heading>div{flex:1 1 180px}
 .ranking .ranking-heading p{margin-top:4px}
 .ranking .ranking-heading h2{font-size:18px;line-height:1.4}
 .ranking .scope-label{white-space:normal;overflow-wrap:anywhere}
 .ranking .ownership-controls,.ranking .ownership-summary{padding-left:14px;padding-right:14px}
 .ranking .ownership-controls label{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;max-width:100%}
 .ranking .ownership-controls select{min-width:0;max-width:100%;font:inherit}
 .ranking .rank-scroll{overflow:visible;max-height:none}
 .ranking .rank-table[data-mobile-rank]{display:block;width:100%;min-width:0}
 .ranking .rank-table[data-mobile-rank] thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
 .ranking .rank-table[data-mobile-rank] tbody{display:block}
 .ranking .rank-table[data-mobile-rank] tbody>tr{display:grid;grid-template-columns:20px repeat(3,minmax(0,1fr)) auto;gap:8px;padding:10px 12px;border-top:1px solid #e7edf5;align-items:center}
 .ranking .rank-table[data-mobile-rank] td{display:block;min-width:0;width:auto;padding:0;border:0;white-space:normal;overflow-wrap:anywhere}
 .ranking .rank-table[data-mobile-rank] .rank-number{grid-column:1;grid-row:1;align-self:start;padding-top:2px;font-size:12px;font-variant-numeric:tabular-nums}
 .ranking .rank-table[data-mobile-rank] .rank-user{grid-column:2/-1;grid-row:1;min-width:0;width:auto}
 .ranking .rank-user>a{font-size:15px;line-height:1.5;overflow-wrap:anywhere}
 .ranking .rank-user .uid{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-top:2px;line-height:1.6;overflow-wrap:anywhere}
 .ranking .rank-user .copy-id{flex:none;margin:0;padding:4px 7px;min-height:30px;max-width:100%;border-color:transparent;background:transparent;color:#526e8d}
 .ranking .rank-track{width:140px;max-width:100%;height:2px;margin-top:5px;background:#edf2f7;border-radius:3px}
 .ranking .rank-bar{height:2px;opacity:.7}
 .ranking td[data-rank-label]{font-size:16px;line-height:1.5;font-variant-numeric:tabular-nums}
 .ranking td[data-rank-label]:before{content:attr(data-rank-label);display:block;font-size:11px;font-weight:400;color:#6c7d95;line-height:1.6;margin-bottom:2px}
 .ranking .rank-table[data-mobile-rank="6"] td:nth-child(3){grid-column:2;grid-row:2}
 .ranking .rank-table[data-mobile-rank="6"] td:nth-child(4){grid-column:3;grid-row:2}
 .ranking .rank-table[data-mobile-rank="6"] td:nth-child(5){grid-column:4;grid-row:2}
 .ranking .rank-table[data-mobile-rank="6"] td:last-child{grid-column:5;grid-row:2}
 .ranking .rank-table[data-mobile-rank="4"] td:nth-child(3){grid-column:2/5;grid-row:2}
 .ranking .rank-table[data-mobile-rank="4"] td:last-child{grid-column:5;grid-row:2}
 .ranking .rank-filter{width:auto;min-height:40px;padding:7px 8px;white-space:normal;line-height:1.5;background:#f1f6fd;border-color:#e0eaf7;border-radius:8px}
 .ranking .rank-filter[aria-pressed="true"]{background:#205b9e;color:#fff;border-color:#205b9e}
}
`;
function installMobileRanking(){
 const root=document.querySelector('.ranking');if(!root)return;
 function update(){
  for(const table of root.querySelectorAll('.rank-table')){
   const headers=[...table.querySelectorAll('thead th')].map(h=>h.textContent.trim());if(![4,6].includes(headers.length))continue;
   table.dataset.mobileRank=String(headers.length);table.setAttribute('role','table');
   for(const group of table.querySelectorAll('thead,tbody'))group.setAttribute('role','rowgroup');
   for(const header of table.querySelectorAll('thead th'))header.setAttribute('role','columnheader');
   for(const row of table.querySelectorAll('tr'))row.setAttribute('role','row');
   for(const row of table.querySelectorAll('tbody>tr'))for(const [i,cell]of [...row.children].entries()){
    cell.setAttribute('role','cell');if(i>=2&&i<headers.length-1)cell.dataset.rankLabel=headers[i];
   }
  }
 }
 update();let queued=false;
 new MutationObserver(changes=>{if(queued||!changes.some(c=>[...c.addedNodes].some(n=>n.nodeType===1&&(n.matches('.rank-table,thead,tbody,tr')||n.querySelector('.rank-table')))))return;queued=true;queueMicrotask(()=>{queued=false;update();});}).observe(root,{childList:true,subtree:true});
}
function markup(){return '<style data-mobile-ranking-style="'+VERSION+'">'+STYLE+'</style><script data-mobile-ranking="'+VERSION+'">('+installMobileRanking.toString()+')();</script>';}
function repair(html){
 if(!html.includes('class="panel ranking"')||!html.includes('id="weibo-report-records"')||!/<\/body>/i.test(html))return null;
 if(html.includes('<style data-mobile-ranking-style="'+VERSION+'">'+STYLE)&&html.includes('<script data-mobile-ranking="'+VERSION+'">'))return null;
 const clean=html.replace(/<style\b[^>]*data-mobile-ranking-style="[^"]*"[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<script\b[^>]*data-mobile-ranking="[^"]*"[^>]*>[\s\S]*?<\/script>/gi,'');return clean.replace(/<\/body>/i,markup()+'</body>');
}
module.exports={VERSION,STYLE,installMobileRanking,markup,repair};
