'use strict';
// Content quality only. These fields never certify ownership, continuity or fees.
const PRECISIONS=new Set(['second','minute','minute-inferred-year','relative-minute','relative','unknown']);
function precision(row){if(PRECISIONS.has(row?.timePrecision))return row.timePrecision;if(!Number.isFinite(row?.ms))return 'unknown';return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(row.time||'')?'second':'unknown';}
const rank=row=>({second:5,minute:4,'minute-inferred-year':3,'relative-minute':2,relative:1,unknown:0}[precision(row)]);
function timeFields(raw,display,ms){const value=String(raw??'');return {time:display,ms,timeRaw:value,timePrecision:!Number.isFinite(ms)?'unknown':/\d\d:\d\d:\d\d/.test(value)?'second':/\d\d:\d\d/.test(value)?'minute':'unknown'};}
function mergeTime(a,b){
 if(!Number.isFinite(a.ms))return Number.isFinite(b.ms)?pick(b):pick(a);
 if(!Number.isFinite(b.ms))return pick(a);
 const ar=rank(a),br=rank(b),compatible=Math.floor(a.ms/60000)===Math.floor(b.ms/60000);
 // Relative timestamps are estimates; repeated observation must not move a row.
 if(ar<=2&&br<=2)return pick(a.ms<=b.ms?a:b);
 if(ar<=2&&br>2)return pick(b);if(br<=2&&ar>2)return pick(a);
 if(compatible&&br>ar)return pick(b);if(compatible&&ar>br)return pick(a);
 if(a.ms===b.ms){const left=pick(a),right=pick(b);return JSON.stringify(left)<=JSON.stringify(right)?left:right;}
 return pick(a); // contradictory reliable times remain with the existing version
}
function pick(r){const v={};for(const k of ['time','ms','timeRaw','timePrecision'])if(r[k]!=null)v[k]=r[k];return v;}
function text(row){let value=String(row?.content||'').replace(/\r\n?/g,'\n');const m=value.match(/^回复\s*@([^:\n：]+)[:：]\s*/u);if(m&&row.replyAuthor===m[1].trim())value=value.slice(m[0].length);return value;}
function media(row){return !!row?.pictures?.items?.some(p=>typeof p.url==='string'&&/^https?:\/\//.test(p.url))||!!require('./comment-media').normalize(row?.commentMedia,row||{});}
function expanded(raw){for(const value of [raw?.longText?.longTextContent,raw?.long_text?.content])if(typeof value==='string'&&value.trim())return value;return null;}
function commentText(raw){return expanded(raw)??raw?.text_raw??raw?.text??raw?.content??'';}
module.exports={expanded,commentText,PRECISIONS,precision,rank,timeFields,mergeTime,text,media};
