'use strict';
(function(root){
 const DAY=86400000;
 function validDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number(value.slice(0,4))<1000)return false;const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;}
 function bounds(from='',to=''){
  if(typeof from!=='string'||typeof to!=='string'||from&&!validDay(from)||to&&!validDay(to))throw Error('请选择有效日期，只需 YYYY-MM-DD');
  if(from&&to&&from>to)throw Error('截止日期不能早于起始日期（--from 不能晚于 --to）');
  return {startMs:from?Date.parse(from+'T00:00:00+08:00'):-Infinity,endMs:to?Date.parse(to+'T00:00:00+08:00')+DAY-1:Infinity};
 }
 function label(from,to,empty='全部日期'){return from&&to?from+' — '+to:from?from+' 起':to?'截至 '+to:empty;}
 function fileKey(from,to){return (from?from.replaceAll('-',''):'最早')+'-'+(to?to.replaceAll('-',''):'最新');}
 // Display and calendar filters use the same fixed civil offset (UTC+08:00).
 function formatTimestamp(ms){
  const date=new Date(Number.isFinite(ms)?ms+8*3600000:NaN);
  return Number.isFinite(date.getTime())?date.toISOString().split('.')[0].replace('T',' '):'';
 }
 function dayOf(ms){return formatTimestamp(ms).split(' ')[0];}
 function displayMinute(ms){return formatTimestamp(ms).slice(0,16).replaceAll('-','/')||'时间未知';}
 function displayDay(ms){
  const day=dayOf(ms);if(!day)return '';
  const [year,month,date]=day.split('-');return year+'年'+Number(month)+'月'+Number(date)+'日';
 }
 const api={validDay,bounds,label,fileKey,formatTimestamp,dayOf,displayMinute,displayDay};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ReaderDates=api;
})(globalThis);
