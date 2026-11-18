'use strict';
// Only verified linear prices can be multiplied by returned rows or requests.
// A tier's advertised minimum is never a safe unit price or reservation limit.
function amount(value){
 if(typeof value!=='number'&&typeof value!=='string')return null;
 if(typeof value==='string'&&!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))return null;
 const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER?n:null;
}
function parse(raw,{group,action,types=['per_record','per_call'],serviceKind=''}={}){
 const command=raw?.command||raw,p=command?.pricing,type=command?.price_type;
 if(!command||command.group!==group||command.action!==action||command.method!=='GET'||!types.includes(type)||!['per_record','per_call'].includes(type)||p?.configured!==true||!['credit','credits'].includes(p.currency))return null;
 const price=amount(p.unit_price);if(price==null)return null;
 const billingType=type==='per_record'?1:2;
 for(const value of [command.billing_type,p.billing_type])if(value!==undefined&&(typeof value!=='number'&&typeof value!=='string'||amount(value)!==billingType))return null;
 if(p.rules!==undefined&&(!Array.isArray(p.rules)||p.rules.length)||p.tier_boundary!=null)return null;
 for(const value of [command.price_per_unit,p.price_per_unit,p.min_price,p.max_price])if(value!==undefined&&(amount(value)==null||amount(value)!==price))return null;
 const trial=serviceKind==='trial_active'&&[true,1].includes(command.trial_enabled);
 return {unitPrice:trial?0:price,standardUnitPrice:price,priceType:type,trial};
}
module.exports={parse};
