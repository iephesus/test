'use strict';
// Cross-process barrier. Exchange snapshots/commits exclude every active writer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readerRoot, canonical } = require('./data-layout');
const leases = require('./process-lease');
// Check every existing parent before mkdir, including when the final folder is absent.
// The selected workspace itself may be a macOS realpath alias.
function directory(base,relative,{create=false}={}){
    const home=path.resolve(base),target=path.resolve(home,relative),rel=path.relative(home,target);
    const fail=()=>Object.assign(Error('资料目录内路径无法核实或越界'),{code:'LOCAL_SOURCE_INVALID'});
    if(!rel||rel.startsWith('..'+path.sep)||rel==='..'||path.isAbsolute(rel))throw fail();
    if(create)fs.mkdirSync(home,{recursive:true});
    const origin=canonical(home);let current=home;
    for(const part of rel.split(path.sep)){
        current=path.join(current,part);let stat;
        try{stat=fs.lstatSync(current);}catch(e){if(e.code!=='ENOENT')throw e;}
        if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw fail();
        if(!canonical(current).startsWith(origin+path.sep))throw fail();
        if(!stat&&create){try{fs.mkdirSync(current);}catch(e){if(e.code!=='EEXIST')throw e;}const made=fs.lstatSync(current);if(!made.isDirectory()||made.isSymbolicLink()||!canonical(current).startsWith(origin+path.sep))throw fail();}
    }
    return target;
}
function locked(base) { return leases.active(path.join(directory(base,'data/.reader/data-access'), 'exclusive.json')); }
function enter(base, mode = 'writer') {
    if (!['writer', 'exclusive'].includes(mode))
        throw Error('数据访问方式无效');
    const dir = directory(base,'data/.reader/data-access',{create:true});
    const exclusive = path.join(dir, 'exclusive.json');
    if (mode === 'exclusive') {
        const lease = leases.acquire(exclusive, '另一数据交换正在进行');
        try {
            for (const name of fs.readdirSync(dir).filter(n => n.startsWith('writer-') && n.endsWith('.json'))) {
                if (leases.active(path.join(dir, name)))
                    throw Error('数据任务仍在保存，请完成后重试');
            }
            return lease.release;
        }
        catch (e) {
            lease.release();
            throw e;
        }
    }
    if (locked(base))
        throw Error('数据包正在合并或导出，请完成后重试');
    const lease = leases.acquire(path.join(dir, 'writer-' + crypto.randomUUID() + '.json'));
    try {
        if (locked(base))
            throw Error('数据包正在处理，请完成后重试');
        return lease.release;
    }
    catch (e) {
        lease.release();
        throw e;
    }
}
function withAccess(base, mode, fn) {
    const release = enter(base, mode);
    try {
        const result = fn();
        if (result && typeof result.then === 'function')
            return result.finally(release);
        release();
        return result;
    }
    catch (e) {
        release();
        throw e;
    }
}
function enterObject(base,kind,id){
    if(!['user','post'].includes(kind)||typeof id!=='string'||!/^\d{5,20}$/.test(id))throw Error('数据对象锁身份无效');
    return leases.acquire(path.join(directory(base,'data/.reader/object-access',{create:true}),kind+'.'+id+'.lock'),'该用户或博文正在获取数据，请等待当前任务保存后重试').release;
}
module.exports = { enter, enterObject, withAccess, locked, directory };
