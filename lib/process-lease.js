'use strict';
// A nonempty directory is published atomically. Each owner removes only its own
// immutable nonce file; an obsolete owner cannot unlink a replacement lease.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
function processBirth(pid) {
    try {
        if (process.platform === 'linux') {
            const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        }
        if (process.platform === 'win32')
            return null;
        return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim() || null;
    }
    catch {
        return null;
    }
}
function renameConflict(error) {
    if (!error) return false;
    if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code)) return true;
    // Windows often reports EPERM/EACCES when the destination lock path already exists.
    return process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code);
}
const ownBirth = processBirth(process.pid);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs;
function inspect(file) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw e;
    }
    if (stat.isSymbolicLink())
        throw Error('数据锁不可使用符号链接');
    if (stat.isFile()) {
        const pid = Number(require('./regular-file').read(file).toString('utf8'));
        if (!Number.isSafeInteger(pid) || pid < 1)
            throw Error('旧版数据锁状态无法核实');
        return { file, stat, pid, legacy: true };
    }
    if (!stat.isDirectory())
        throw Error('数据锁不是可核实的普通文件或目录');
    const names = fs.readdirSync(file);
    if (names.length === 0)
        return { file, stat, empty: true };
    if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(names[0]))
        throw Error('数据锁持有者信息损坏');
    const ownerFile = path.join(file, names[0]), ownerStat = fs.lstatSync(ownerFile);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink())
        throw Error('数据锁持有者信息无效');
    const owner = JSON.parse(require('./regular-file').read(ownerFile).toString('utf8'));
    if (owner.schema !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || 'owner-' + owner.id + '.json' !== names[0] || owner.birth != null && typeof owner.birth !== 'string')
        throw Error('数据锁身份无法核实');
    return { file, stat, ownerFile, ownerStat, ...owner };
}
function running(info, birth = processBirth) {
    if (info.empty)
        return false;
    try {
        process.kill(info.pid, 0);
    }
    catch (e) {
        if (e.code === 'ESRCH')
            return false;
        if (e.code !== 'EPERM')
            throw e;
    }
    // Legacy PID-only locks remain conservative. New leases distinguish PID reuse.
    if (info.legacy || !info.birth)
        return true;
    const current = info.pid === process.pid ? ownBirth : birth(info.pid);
    return !current || current === info.birth;
}
function remove(info) {
    try {
        if (info.legacy) {
            if (sameFile(info.stat, fs.lstatSync(info.file)))
                fs.unlinkSync(info.file);
        }
        else {
            if (info.ownerFile) {
                if (!sameFile(info.ownerStat, fs.lstatSync(info.ownerFile)))
                    return;
                fs.unlinkSync(info.ownerFile);
            }
            // rmdir cannot remove a newly published nonempty owner directory.
            fs.rmdirSync(info.file);
        }
    }
    catch (e) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EISDIR', 'ENOTDIR'].includes(e.code))
            throw e;
    }
}
function active(file) {
    for (let attempt = 0; attempt < 3; attempt++) {
        let info;
        try {
            info = inspect(file);
        }
        catch (e) {
            if (e.code === 'ENOENT')
                continue;
            throw e;
        }
        if (!info)
            return false;
        if (running(info))
            return true;
        remove(info);
    }
    return !!inspect(file);
}
function acquire(file, message = '该数据正在由另一任务处理，请等待完成') {
    file = path.resolve(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = crypto.randomUUID(), claim = file + '.claim-' + id;
    const name = 'owner-' + id + '.json';
    fs.mkdirSync(claim, { mode: 0o700 });
    try {
        fs.writeFileSync(path.join(claim, name), JSON.stringify({ schema: 1, id, pid: process.pid, birth: ownBirth }), { mode: 0o600, flag: 'wx' });
        for (let attempt = 0;; attempt++) {
            try {
                fs.renameSync(claim, file);
                break;
            }
            catch (e) {
                if (!renameConflict(e))
                    throw e;
                if (attempt >= 3 || active(file)) {
                    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code) && !inspect(file))
                        throw Object.assign(Error('无法创建数据锁（系统拒绝重命名）。请确认资料目录可写，并排除杀毒软件拦截后重试'), { code: 'DATA_LOCK_DENIED', cause: e });
                    throw Object.assign(Error(message), { code: 'DATA_LOCK_BUSY' });
                }
            }
        }
    }
    finally {
        fs.rmSync(claim, { recursive: true, force: true });
    }
    let released = false;
    const owned = () => { const info = inspect(file); return !released && info?.id === id && info.pid === process.pid && info.birth === ownBirth; };
    function release() {
        if (released)
            return;
        const info = inspect(file);
        released = true;
        if (info?.id === id && info.pid === process.pid && info.birth === ownBirth)
            remove(info);
    }
    return { release, owned, file, id };
}
function withLease(file, fn, message) {
    const lease = acquire(file, message);
    try {
        const result = fn();
        if (result && typeof result.then === 'function')
            return result.finally(lease.release);
        lease.release();
        return result;
    }
    catch (e) {
        lease.release();
        throw e;
    }
}
module.exports = { acquire, active, inspect, running, processBirth, renameConflict, withLease };
