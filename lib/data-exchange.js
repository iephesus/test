'use strict';
// Portable content-only container. It is not a ZIP and never extracts caller paths.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const S = require('./exchange-schema'), E = require('./exchange-records');
const staging = require('./exchange-stage');
const { storagePaths, indexRead, mappedFolder, findPostFolder, postIdFromFolder } = require('./storage');
const { readerRoot, canonical } = require('./data-layout');
const { atomic, token } = require('./update-progress');
const MAGIC = Buffer.from('WEIBO-READER-DATA\n'), FORMAT = 1;
const LIMITS = { manifest: 32 * 1024 * 1024, file: 128 * 1024 * 1024, total: 4 * 1024 * 1024 * 1024, files: 100000, objects: 10000 };
const root = base => require('./workspace-access').directory(base,path.relative(path.resolve(base),path.resolve(readerRoot(base),'exchange')));
const pendingFile = base => path.join(root(base), 'pending.json');
const jobFile = (base, id) => path.join(root(base), 'transactions', id, 'job.json');
const recoveryMarker = folder => path.join(folder, 'pending-pointer-v1.ready');
const transactionId = /^[a-f0-9-]{36}$/;
const ABSENT = Symbol('absent');
const stamp = f => { const s = fs.lstatSync(f, { bigint: true }); if (!s.isFile() || s.isSymbolicLink())
    throw Error('数据交换只接受普通文件'); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join('/'); };
function durable(file, bytes, { exclusive = false } = {}) {
    const sync = require('./fs-sync');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        sync.file(fd);
        fs.closeSync(fd);
        fd = null;
        if (exclusive) {
            fs.linkSync(tmp, file);
            fs.unlinkSync(tmp);
        }
        else
            fs.renameSync(tmp, file);
        sync.directory(path.dirname(file));
    }
    finally {
        if (fd != null)
            fs.closeSync(fd);
        fs.rmSync(tmp, { force: true });
    }
}
function writeJob(base, job) { durable(jobFile(base, job.id), Buffer.from(JSON.stringify(job))); }
function read(file, fallback = null) { try {
    return JSON.parse(require('./regular-file').read(file,{maxBytes:LIMITS.file}));
}
catch (e) {
    if (e.code === 'ENOENT')
        return fallback;
    throw e;
} }
function readPending(base) {
    const pointer=read(pendingFile(base),ABSENT);
    if(pointer===ABSENT)return null;
    if(!pointer||typeof pointer.id!=='string'||!transactionId.test(pointer.id)||pointer.schema!==1)throw Error('合并恢复索引损坏，原始事务保留');
    return pointer;
}
function recoveryIndexed(folder) {
    try { const stat=fs.lstatSync(recoveryMarker(folder));return stat.isFile()&&stat.size===0; }
    catch(error){if(error.code==='ENOENT')return false;throw error;}
}
// Caller holds exclusive workspace access. Only pre-upgrade workspaces need a
// directory scan. An old unindexed applying plan may predate newer local saves.
function indexLegacyRecovery(base) {
    const folder=root(base),marker=recoveryMarker(folder);
    if(recoveryIndexed(folder))return;
    try{fs.lstatSync(marker);throw Error('数据合并恢复标记无效，原始事务保留');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(readPending(base))return;
    const transactions=require('./workspace-access').directory(base,path.relative(base,path.join(folder,'transactions'))),detached=[];
    if(fs.existsSync(transactions))for(const name of fs.readdirSync(transactions).filter(name=>transactionId.test(name))){
        require('./workspace-access').directory(base,path.relative(base,path.join(transactions,name)));
        const job=read(jobFile(base,name));
        if(job?.status==='applying'&&!superseded(base,name))detached.push(name);
    }
    if(detached.length>1)throw Error('存在多个未登记的旧合并事务，原始证据保留');
    if(detached.length===1)durable(pendingFile(base),Buffer.from(JSON.stringify({schema:1,id:detached[0],detachedLegacy:true})));
    durable(marker,Buffer.alloc(0));
}
function directoryLookup(base) {
    const roots=storagePaths(base),indexes=new Map();
    return (owner,category)=>{
        if(owner.kind==='post')return findPostFolder(roots.postComments,owner.id);
        const folder=category==='posts'?roots.posts:roots.users;
        if(!indexes.has(folder))indexes.set(folder,indexRead(folder));
        return mappedFolder(folder,owner.id,indexes.get(folder));
    };
}
function objects(base) {
    const list = new Map();
    for (const u of require('../desktop/library').listAccounts(base))
        list.set('user:' + u.uid, { kind: 'user', id: u.uid, nickname: u.nickname || '' });
    const p = storagePaths(base);
    for (const category of ['users', 'posts'])
        for (const [id, v] of Object.entries(indexRead(p[category])))
            if (/^\d{5,20}$/.test(id))
                list.set('user:' + id, { ...list.get('user:' + id), kind: 'user', id, nickname: v.nickname || id });
    for (const {post} of require('./post-metadata').listMetadata(base))
        list.set('post:' + post.postId, { kind: 'post', id: post.postId, title: post.title || '', author: post.author || '', authorUid: post.authorUid || '' });
    return [...list.values()].sort((a, b) => S.key(a).localeCompare(S.key(b)));
}
function selected(base, selection) { const known = objects(base), map = new Map(known.map(o => [S.key(o), o])); if (selection === 'all' || selection == null)
    return known; if (!Array.isArray(selection) || !selection.length)
    throw Error('请选择至少一个用户或博文'); return [...new Map(selection.map(o => { const v = S.owner(o), meta = map.get(S.key(v)); if (!meta)
        throw Error('所选对象不存在：' + S.key(v)); return [S.key(v), meta]; })).values()]; }
function safeFile(base, relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p === '.' || !p) || relative.includes('\0'))
        throw Error('本地事务路径无效');
    const target = path.resolve(base, relative), allowed = /^(?:data|output)\/(?:user-comments|post-comments|posts)\/[^/]+\/(?:cache\/exchange-v1\/(?:[a-f0-9]{64}\.json|preferred\.json)|cache\/update-connections\/[a-f0-9-]{36}\.json|cache\/updates\/(?:sent|received|mentions-comments|mentions-posts)\.json|images\/[a-f0-9]{64}(?:_[a-f0-9]{16})?\.(?:jpg|png|gif|webp|avif))$/.test(relative) || /^(?:data|output)\/(?:user-comments|posts)\/\.account_names\.json$/.test(relative) || /^(?:data|output)\/\.reader\/(?:users\.json|posts\.json|profiles\/\d{5,20}\/(?:identity\.json|[a-f0-9]{64}\.(?:jpg|png|gif|webp|avif)))$/.test(relative) || /^(?:data|output)\/(?:user-comments)\/[^/]+\/cache\/follow-inbox\.json$/.test(relative) || /^(?:data|output)\/post-comments\/[^/]+\/cache\/post-reading-state\.json$/.test(relative);
    if (!allowed && relative!=='data/.reader/exchange-content-v1.sqlite')
        throw Error('事务目标不在内容白名单中');
    let current = base;
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
            throw Error('事务目标含符号链接');
    }
    if (!canonical(target).startsWith(canonical(base) + path.sep))
        throw Error('事务目标越界');
    return target;
}
function assertIdle(base) {
    for (const t of require('../desktop/user-workspace').tasks(base))
        if (t.status === 'running')
            throw Error('数据任务正在保存，请稍后重试');
    const leases = require('./process-lease'), p = storagePaths(base);
    for (const category of [p.users, p.posts, p.postComments])
        if (fs.existsSync(category))
            for (const d of fs.readdirSync(category, { withFileTypes: true })) {
                if (!d.isDirectory() || d.isSymbolicLink())
                    continue;
                const locks = path.join(category, d.name, 'cache/updates');
                if (fs.existsSync(locks))
                    for (const n of fs.readdirSync(locks).filter(n => n.endsWith('.lock')))
                        if (leases.active(path.join(locks, n)))
                            throw Error('该数据仍有其他读取任务');
            }
    const session = leases.inspect(path.join(readerRoot(base), 'auto-follow/session.lock'));
    if (session && session.pid !== process.pid && leases.running(session))
        throw Error('另一应用窗口拥有此目录，请先关闭该窗口');
}
function footprint(base, owners) {
    const found = [['shared-content',require('./exchange-store').signature(base)]],directory=directoryLookup(base);
    function walk(dir, depth) { if (!fs.existsSync(dir))
        return; if (fs.lstatSync(dir).isSymbolicLink() || !canonical(dir).startsWith(canonical(base) + path.sep))
        throw Error('导出数据目录包含符号链接或越界路径'); for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink())
            throw Error('对象数据包含符号链接，未进行交换');
        const f = path.join(dir, e.name);
        if (e.isDirectory() && depth)
            walk(f, depth - 1);
        else if (e.isFile() && !e.name.endsWith('.lock') && !e.name.endsWith('.tmp'))
            found.push([path.relative(base, f), stamp(f)]);
    } }
    for (const o of owners) {
        for (const category of o.kind === 'user' ? ['user-comments', 'posts'] : ['post-comments'])
            walk(directory(o,category), 4);
    }
    for (const f of ['users.json', 'posts.json']) {
        const p = path.join(readerRoot(base), f);
        if (fs.existsSync(p))
            found.push([f, stamp(p)]);
    }
    for (const category of ['users', 'posts']) {
        const f = path.join(storagePaths(base)[category], '.account_names.json');
        if (fs.existsSync(f))
            found.push([f, stamp(f)]);
    }
    for (const o of owners) {
        const uid = o.kind === 'user' ? o.id : o.authorUid;
        if (uid)
            walk(path.join(readerRoot(base), 'profiles', uid), 0);
    }
    return S.hash(S.stable(found.sort((a, b) => a[0].localeCompare(b[0]))));
}
async function build(base, selection, stage, signal) {
    const checkpoint=require('./local-work').checkpoint(signal);
    const owners = selected(base, selection);
    if (!owners.length)
        throw Error('还没有可以导出的对象');
    // Large row collections use the same private hash staging, separately from
    // final package entries so scratch bytes cannot consume the package quota.
    const start = footprint(base, owners),directory=directoryLookup(base),files = new Map(), warnings = [], writer=staging.writer(stage,durable);let recordWriter;
    const recordStore={put(bytes,hash){recordWriter??=staging.writer(path.join(stage,'record-rows'),durable);return recordWriter.put(bytes,hash);},get(hash){if(!recordWriter)throw Error('独立记录暂存缺失');return recordWriter.get(hash);}};
    try {
    function add(role, o, bytes, extra = {}) { if (bytes.length > LIMITS.file)
        throw Error('单个内容文件超过交换上限'); const h = S.hash(bytes), key = role + '/' + S.key(o) + '/' + h; if (files.has(key))
        return h; const ext = ['image', 'avatar'].includes(role) ? '.' + extra.extension : '.json', logical = 'objects/' + o.kind + '/' + o.id + '/' + role + '/' + h + ext; writer.put(bytes,h); files.set(key, { role, owner: S.owner(o), path: logical, sha256: h, bytes: bytes.length, ...extra }); return h; }
    function json(v) { const bytes=Buffer.from(S.stable(v));validateEntry({role:v.role,owner:v.owner},bytes);return add(v.role,v.owner,bytes); }
    function packet(o, kind, q, raw, when, trusted = true) {
        const value = { schema: 1, role: 'packet', owner: S.owner(o), channel: S.channel(o, kind), query: S.query(q, o, kind), response: S.response(raw, kind), savedAt: when, trusted: !!trusted };
        try {
            E.validatePacket(value);
        }
        catch (e) {
            value.trusted = false;
            warnings.push(S.key(o) + ' · ' + kind + '：仅保留内容，' + e.message);
        }
        return json(value);
    }
    for (const o of owners) {
        signal?.throwIfAborted();
        for (const category of o.kind === 'user' ? ['user-comments', 'posts'] : ['post-comments']) {
            const dir = directory(o,category), cache = path.join(dir, 'cache'), records=require('./exchange-record-export').create(o,{store:recordStore});
            if (!fs.existsSync(cache))
                continue;
            const mirrors=require('./exchange-mirrors').collect(dir,o.id);
            for (const e of fs.readdirSync(cache, { withFileTypes: true })) {
                await checkpoint();
                if (!e.isFile() || !e.name.endsWith('.json'))
                    continue;
                const f = path.join(cache, e.name);
                let kind, q, raw, when = new Date(fs.statSync(f).mtimeMs).toISOString();
                const match = e.name.match(/^(sent|received|mentions-comments|mentions-posts|post-comments)_c(\d+)_m(\d+)(?:_s(\d+))?(?:_p(\d+))?(_legacy_[a-f0-9]{16})?\.json$/), first = e.name.match(/^(sent|received|mentions-comments|mentions-posts)_page1\.json$/);
                try {
                    if (match || first) {
                        kind = match?.[1] || first[1];
                        raw = read(f);
                        q = { count: match ? Number(match[2]) : Math.max(1, require('./core').rawArray(raw, kind)?.items.length || 1), maxId: match?.[3] === '0' ? '' : match?.[3] || '', sinceId: match?.[4] || '', page: Number(match?.[5] || 1) };
                    }
                    else if (category === 'posts' && e.name.startsWith('user-posts_')) {
                        const box = read(f);
                        if (box.schema !== 1 || box.endpoint !== 'statuses user_timeline/other' || box.query?.uid !== o.id)
                            continue;
                        kind = 'user-posts';
                        q = box.query;
                        raw = box.response;
                        when = box.savedAt || when;
                    }
                    else
                        continue;
                    const mirror=mirrors.get(path.resolve(f));if(mirror&&S.stable(S.query(mirror.query,o,kind))===S.stable(S.query(q,o,kind)))when=mirror.savedAt;
                    packet(o, kind, q, raw, when, !match?.[6]);
                }
                catch (error) {
                    warnings.push(S.key(o) + '：部分旧内容格式不受支持（' + error.message + '）');
                }
            }
            const receipts = path.join(cache, 'request-journal');
            if (fs.existsSync(receipts))
                for (const n of fs.readdirSync(receipts).filter(n => /^[a-f0-9-]+\.response\.json$/.test(n))) {
                    const f = path.join(receipts, n);
                    try {
                        const b = read(f);
                        if (b.schema !== 1 || b.query?.uid !== o.id)
                            continue;
                        packet(o, b.query.kind, b.query, b.response, b.savedAt);
                    }
                    catch (e) {
                        warnings.push(S.key(o) + '：一份响应仅能保留在原目录（' + e.message + '）');
                    }
                }
            for (const name of ['report-snapshots', 'batches']) {
                const folder = path.join(cache, name);
                if (!fs.existsSync(folder))
                    continue;
                for (const n of fs.readdirSync(folder).filter(n => n.endsWith('.json'))) {
                    const b = read(path.join(folder, n));
                    if (b.schema !== 1 || b.uid !== o.id || !Array.isArray(b.rows))
                        continue;
                    const groups = new Map();
                    for (const r of b.rows) {
                        const kinds = r.group === 'both' || r.type === '发出/收到' ? (r.directions?.filter(k => ['sent', 'received'].includes(k)) || [r.authorUid === o.id ? 'sent' : 'received']) : [r.group];
                        for (const kind of kinds)
                            try {
                                S.channel(o, kind);
                                if (!groups.has(kind))
                                    groups.set(kind, []);
                                groups.get(kind).push(r);
                            }
                            catch { }
                    }
                    for (const [kind, rows] of groups)
                        records.add(kind,rows,b.createdAt || new Date(fs.statSync(path.join(folder,n)).mtimeMs).toISOString(),{skipInvalid:true});
                }
            }
            for (const e of E.iterateEntries(dir))
                if (['packet', 'records'].includes(e.value.role)) {
                    if(e.value.role==='records')records.add(e.value.channel,e.value.rows,e.value.savedAt);
                    else json(e.value);
                }
            await records.flush(json,checkpoint);
            const images = path.join(dir, 'images');
            if (fs.existsSync(images))
                for (const n of fs.readdirSync(images)) {
                    const f = path.join(images, n);
                    if (!fs.lstatSync(f).isFile() || fs.lstatSync(f).isSymbolicLink())
                        throw Error('图片不是普通文件');
                    const bytes = require('./regular-file').read(f,{maxBytes:LIMITS.file}), extension = require('./image-cache').imageType(bytes);
                    if (extension && /^[a-f0-9]{64}(?:_[a-f0-9]{16})?\.(jpg|png|gif|webp|avif)$/.test(n))
                        add('image', o, bytes, { extension, name: n, category });
                }
        }
        const uid = o.kind === 'user' ? o.id : o.authorUid;
        if (uid) {
            const profile = require('../desktop/user-profiles').cached(base, uid);
            if (profile.avatarData) {
                const bytes = Buffer.from(profile.avatarData.split(',')[1], 'base64'), extension = require('./image-cache').imageType(bytes);
                if (extension)
                    add('avatar', o, bytes, { extension, profileUid: uid });
            }
            if(Number.isFinite(Date.parse(profile.remoteSucceededAt)))o.profileAt=profile.remoteSucceededAt;
            if(profile.nickname){if(o.kind==='user')o.nickname=profile.nickname;else o.author=profile.nickname;}
        }
    }
    if (footprint(base, owners) !== start)
        throw Error('导出期间数据发生变化，未生成混合快照；请重试');
    const metadata = owners.map(o => { const v = { ...S.owner(o) }; for (const k of ['nickname', 'title', 'author', 'authorUid','profileAt'])
        if (typeof o[k] === 'string' && o[k])
            v[k] = o[k]; return v; });
    const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (list.length > LIMITS.files)
        throw Error('数据包文件数量超过安全上限');
    writer.seal();
    return { manifest: { format: 'weibo-reader-data', version: FORMAT, createdAt: new Date().toISOString(), objects: metadata, files: list }, warnings };
    } finally {try{writer.close();}finally{recordWriter?.close();}}
}
async function exportPackage(base, selection, destination, { signal } = {}) {
    return require('./workspace-access').withAccess(base, 'exclusive', async () => {
        assertIdle(base);
        if(pending(base))throw Error('有待恢复的数据合并，请完成恢复后再导出');
        const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-exchange-export-'));
        let temp,phase='assemble';
        try {
            const { manifest, warnings } = await build(base, selection, stage, signal), header = Buffer.from(S.stable(manifest));
            if (header.length > LIMITS.manifest)
                throw Error('文件清单过大');
            let total = header.length + MAGIC.length + 4 + manifest.files.reduce((n, f) => n + f.bytes, 0);
            if (total > LIMITS.total)
                throw Error('数据包超过安全体积上限');
            phase='publish';
            const parent = fs.realpathSync(path.dirname(destination));
            let target = path.join(parent, path.basename(destination));
            if (!target.endsWith('.wrdpack'))
                target += '.wrdpack';
            while (fs.existsSync(target))
                target = target.replace(/\.wrdpack$/, '_' + crypto.randomUUID().slice(0, 8) + '.wrdpack');
            temp = target + '.' + crypto.randomUUID() + '.tmp';
            const sink=require('./exchange-compression').writer(temp,{signal});
            try{await sink.write(MAGIC);const length=Buffer.alloc(4);length.writeUInt32BE(header.length);await sink.write(length);await sink.write(header);for(const f of manifest.files){signal?.throwIfAborted();await sink.write(staging.get(stage,f.sha256));await new Promise(setImmediate);}total=await sink.finish();}finally{await sink.close();}
            fs.linkSync(temp,target);
            fs.unlinkSync(temp);
            require('./fs-sync').directory(parent);
            temp = null;
            return { file: target, objects: manifest.objects, files: manifest.files.length, bytes: total, compression:'gzip',warnings, partial: warnings.length > 0, credits: 0 };
        }
        catch(error){require('./exchange-diagnostics').record(base,'export',phase,error,durable);throw error;}
        finally {
            if (temp)
                fs.rmSync(temp, { force: true });
            fs.rmSync(stage, { recursive: true, force: true });
        }
    });
}
function validateManifest(m) {
    if (m && Object.keys(m).some(k => !['format', 'version', 'createdAt', 'objects', 'files'].includes(k)))
        throw Error('清单包含未允许字段');
    if (!m || m.format !== 'weibo-reader-data' || m.version !== FORMAT)
        throw Error('不支持的数据包版本，请使用相同或兼容版本导出的 .wrdpack 文件');
    if (!Array.isArray(m.objects) || !m.objects.length || m.objects.length > LIMITS.objects || !Array.isArray(m.files) || m.files.length > LIMITS.files)
        throw Error('数据包对象或文件数量无效');
    const owners = new Map();
    for (const o of m.objects) {
        S.owner(o);
        if (owners.has(S.key(o)))
            throw Error('数据包含重复对象');
        owners.set(S.key(o),o);
        for (const k of Object.keys(o))
            if (!['kind', 'id', 'nickname', 'title', 'author', 'authorUid','profileAt'].includes(k) || !['string'].includes(typeof o[k]))
                throw Error('对象信息包含不支持的字段');
        if(o.profileAt&&!Number.isFinite(Date.parse(o.profileAt)))throw Error('资料采集时间无效');
        if (o.authorUid)
            S.id(o.authorUid);
    }
    const paths = new Set();
    let total = 0;
    for (const f of m.files) {
        S.owner(f.owner);
        if (S.stable(S.owner(f.owner)) !== S.stable(f.owner) || Object.keys(f).some(k => !['role', 'owner', 'path', 'sha256', 'bytes', 'extension', 'name', 'category', 'profileUid'].includes(k)))
            throw Error('文件清单包含未允许字段');
        if (!owners.has(S.key(f.owner)) || !['packet', 'records', 'progress', 'image', 'avatar'].includes(f.role) || !S.safePath(f.path) || paths.has(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > LIMITS.file)
            throw Error('数据包文件清单无效、越界或过大');
        const ext = ['image', 'avatar'].includes(f.role) ? '.' + f.extension : '.json';
        if (f.path !== 'objects/' + f.owner.kind + '/' + f.owner.id + '/' + f.role + '/' + f.sha256 + ext)
            throw Error('数据包内部路径或文件类型无效');
        if (f.role === 'image') {
            S.assetPath('images/' + f.name);
            if (!(['user-comments', 'posts'].includes(f.category) && f.owner.kind === 'user' || f.category === 'post-comments' && f.owner.kind === 'post'))
                throw Error('图片归属类型无效');
        }
        if (f.role === 'avatar') {
            const o = owners.get(S.key(f.owner));
            if (f.profileUid !== (o.kind === 'user' ? o.id : o.authorUid))
                throw Error('头像 UID 与对象不匹配');
        }
        paths.add(f.path);
        total += f.bytes;
    }
    if (total > LIMITS.total)
        throw Error('数据包展开体积超过上限');
    return total;
}
function validateEntry(f, bytes) {
    if (['image', 'avatar'].includes(f.role)) {
        if (require('./image-cache').imageType(bytes) !== f.extension || f.role === 'avatar' && bytes.length > 2097152)
            throw Error('图片类型或头像大小不受支持');
        return null;
    }
    const v = JSON.parse(bytes);
    if (!S.sameJSON(S.owner(v.owner),v.owner))
        throw Error('对象身份含额外字段');
    if (v.schema !== 1 || v.role !== f.role || S.key(S.owner(v.owner)) !== S.key(f.owner))
        throw Error('文件清单和内容身份不一致');
    S.channel(v.owner, v.channel);
    if (f.role === 'packet') {
        for (const k of Object.keys(v))
            if (!['schema', 'role', 'owner', 'channel', 'query', 'response', 'savedAt', 'trusted'].includes(k))
                throw Error('内容响应含非交换字段');
        if (typeof v.trusted !== 'boolean' || !Number.isFinite(Date.parse(v.savedAt)))
            throw Error('内容响应版本无效');
        // Trusted packet validation includes the same query and response whitelist.
        if (v.trusted)
            E.validatePacket(v);
        else if (!S.sameJSON(S.response(v.response, v.channel),v.response) || !S.sameJSON(S.query(v.query, v.owner, v.channel),v.query))
            throw Error('内容响应含未允许的字段');
    }
    if (f.role === 'records') {
        if (!Array.isArray(v.rows) || v.rows.length > 5000 || !Number.isFinite(Date.parse(v.savedAt)))
            throw Error('独立记录文件无效');
        for (const r of v.rows) {
            if (!S.sameJSON(S.row(r, v.channel),r))
                throw Error('独立记录包含不支持字段');
            if (!r.isContext && (['sent', 'user-posts'].includes(v.channel) && r.authorUid !== v.owner.id || v.channel === 'post-comments' && r.postId !== v.owner.id))
                throw Error('独立记录的归属与对象不一致');
        }
        for (const k of Object.keys(v))
            if (!['schema', 'role', 'owner', 'channel', 'savedAt', 'rows'].includes(k))
                throw Error('记录包含私人字段');
    }
    if (f.role === 'progress') {
        for (const k of Object.keys(v))
            if (!['schema', 'role', 'owner', 'channel', 'state', 'connections', 'unknownOutcome'].includes(k))
                throw Error('进度包含非交换字段');
        for (const k of Object.keys(v.state || {}))
            if (!['uid', 'kind', 'anchor', 'checkedAt', 'endPolicyVersion', 'origin', 'baselineUnverified', 'sinceDisabled', 'scope', 'pending'].includes(k))
                throw Error('成功位置含未允许字段');
        if (!Array.isArray(v.connections) || !v.state || typeof v.state !== 'object' || Array.isArray(v.state))
            throw Error('进度字段类型无效');
        for (const c of v.connections)
            if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['initial', 'lower', 'upper', 'packets'].includes(k)))
                throw Error('连接证据含未允许字段');
        if (v.state.scope != null && (typeof v.state.scope !== 'object' || Array.isArray(v.state.scope) ||
            Object.keys(v.state.scope).some(k => !['recentLimit', 'olderHistoryComplete'].includes(k)) ||
            v.state.scope.recentLimit != null && (!Number.isSafeInteger(v.state.scope.recentLimit) || v.state.scope.recentLimit < 1) ||
            v.state.scope.olderHistoryComplete != null && typeof v.state.scope.olderHistoryComplete !== 'boolean'))
            throw Error('范围含未允许字段');
        if (v.state.pending != null && (typeof v.state.pending !== 'object' || Array.isArray(v.state.pending) ||
            Object.keys(v.state.pending).some(k => !['cursor', 'head', 'startedAt', 'verify', 'since', 'packets'].includes(k))))
            throw Error('续读信息含未允许字段');
        if (v.state?.uid !== v.owner.id || v.state?.kind !== v.channel || !Array.isArray(v.connections) || v.connections.length > 65)
            throw Error('进度对象不匹配');
        if (v.state.sinceDisabled != null && typeof v.state.sinceDisabled !== 'boolean')
            throw Error('接口边界能力状态无效');
        if (typeof v.unknownOutcome !== 'boolean' || typeof v.state.checkedAt !== 'string' || !Number.isFinite(Date.parse(v.state.checkedAt)) || typeof v.state.anchor !== 'string' || S.id(v.state.anchor) !== v.state.anchor || typeof v.state.baselineUnverified !== 'boolean' || typeof v.state.origin !== 'string' || v.state.origin.length > 128)
            throw Error('进度字段类型无效');
        for (const c of v.connections) {
            if (typeof c.initial !== 'boolean' || typeof c.upper !== 'string' || S.id(c.upper) !== c.upper || typeof c.lower !== 'string' || c.lower && S.id(c.lower) !== c.lower || !Array.isArray(c.packets) || c.packets.some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)))
                throw Error('连接证据格式无效');
        }
        if (v.state.pending) {
            const p = v.state.pending;
            if (typeof p.cursor !== 'string' || p.cursor && S.id(p.cursor) !== p.cursor || typeof p.head !== 'string' || S.id(p.head) !== p.head || typeof p.startedAt !== 'string' || !Number.isFinite(Date.parse(p.startedAt)) || typeof p.verify !== 'boolean' || typeof p.since !== 'boolean' || !Array.isArray(p.packets) || p.packets.some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)))
                throw Error('续读证据格式无效');
        }
    }
    return v;
}
// An unsealed old plan is never trusted retroactively. An explicitly selected
// original package can instead be inspected anew against CURRENT local bytes.
function legacyReview(base,fresh){
 const pointer=readPending(base);if(!pointer||pointer.id===fresh.id)return null;
 const oldFile=jobFile(base,pointer.id),old=read(oldFile),cursor=path.join(path.dirname(oldFile),'progress.json');
 if(old?.schema!==1||old.id!==pointer.id||old.status!=='applying'||(fs.existsSync(cursor)&&pointer.detachedLegacy!==true))return null;
 if(old.packageHash!==fresh.packageHash||S.stable(old.manifest)!==S.stable(fresh.manifest))throw Error('旧合并尚待恢复：请选择该事务原来的数据包重新检查，原事务与已保存内容保留');
 validateManifest(old.manifest);for(const f of old.manifest.files)validateEntry(f,staged(base,old,f));
 return {id:old.id,jobHash:token(oldFile),packageHash:fresh.packageHash};
}
function superseded(base,id){
 const file=jobFile(base,id),link=read(path.join(path.dirname(file),'reinspection.json'));if(!link)return false;
 if(link.schema!==1||link.oldHash!==token(file)||!/^[a-f0-9-]{36}$/.test(link.newId||''))throw Error('旧合并重新核实记录损坏，原证据保留');
 const next=read(jobFile(base,link.newId));if(!next||next.packageHash!==link.packageHash||!['inspected','applying','committed'].includes(next.status))throw Error('重新核实后的数据包记录缺失，原证据保留');
 return true;
}
async function inspectContents(base, file, { signal, onPhase } = {}) {
    const parent = path.join(root(base), 'transactions');
    fs.mkdirSync(parent, { recursive: true });
    const id = crypto.randomUUID(), stage = path.join(parent, id);
    fs.mkdirSync(path.join(stage, 'blobs'), { recursive: true });
    let source,phase='validate-header';
    const writer=staging.writer(path.join(stage,'blobs'),durable);
    try {
        source=require('./exchange-compression').reader(file,{signal,maxBytes:LIMITS.total+LIMITS.manifest});const before=source.sourceStamp,take=n=>source.take(n);
        if (!(await take(MAGIC.length)).equals(MAGIC))throw Error('这不是 Weibo Reader 数据包；请由软件导出 .wrdpack');
        const n=(await take(4)).readUInt32BE();if(n>LIMITS.manifest)throw Error('文件清单超过上限');
        const manifest=JSON.parse((await take(n)).toString('utf8')),total=validateManifest(manifest);
        const normalizedFiles=new Map(),repairs=[];phase='validate-content';
        for (const f of manifest.files) {
            signal?.throwIfAborted();
            const b = await take(f.bytes);
            if (S.hash(b) !== f.sha256)
                throw Error('数据包内容哈希校验失败');
            let entry=f,content=b;
            try{validateEntry(entry,content);}catch(error){
                const fixed=require('./exchange-compat').optionalDates(f,b);
                if(!fixed){if(error instanceof SyntaxError)throw Error('数据包中的内容格式无效，请更新导出端后重新导出；本地已有数据未修改。',{cause:error});throw error;}
                validateEntry(fixed.file,fixed.bytes);
                entry=fixed.file;content=fixed.bytes;repairs.push(fixed.repair);
            }
            normalizedFiles.set(entry.path,entry);
            writer.put(content,entry.sha256);
            await new Promise(setImmediate);
        }
        const packageHash=await source.finish(MAGIC.length+4+n+total);
        manifest.files=[...normalizedFiles.values()];
        validateManifest(manifest);
        writer.seal();
        const job = { schema: 1, id, packageHash, source: path.resolve(file), sourceStamp: before, ...(source.compression?{compression:source.compression}:{}),manifest, status: 'inspected', createdAt: new Date().toISOString(), next: 0, compatibility:{optionalDateFiles:repairs.length,repairs} };
        job.reviewOf=legacyReview(base,job);
        job.snapshot = footprint(base, manifest.objects);
        writeJob(base, job);
        phase='inspect-plan';
        onPhase?.('planning');
        return { id, manifest, packageHash: job.packageHash, summary: {...(await plan(base, job, signal)).summary,...(job.reviewOf?{reinspection:true}:{})} };
    }
    catch (e) {
        require('./exchange-diagnostics').record(base,'import',phase,e,durable,id);
        fs.rmSync(stage, { recursive: true, force: true });
        throw e;
    }
    finally {
        writer.close();
        if(source)await source.close();
    }
}
function staged(base, job, f) { return staging.get(path.join(path.dirname(jobFile(base,job.id)),'blobs'),f.sha256); }
const planViews=new Map();let planViewBytes=0;const PLAN_VIEW_LIMIT=16*1024*1024;
function dropPlan(key){const v=planViews.get(key);if(v){planViewBytes-=v.bytes;planViews.delete(key);}}
function stageToken(base,job){const folder=path.join(path.dirname(jobFile(base,job.id)),'blobs');return S.hash(require('./regular-file').list(folder,/^(?:index\.json|data\.bin|[a-f0-9]{64})$/).sort().map(file=>path.basename(file)+':'+token(file)).join('|'));}
async function plan(base, job, signal) {
 signal?.throwIfAborted();const key=jobFile(base,job.id),jobToken=token(key),stageHash=stageToken(base,job),prior=planViews.get(key);
 if(prior&&prior.jobToken===jobToken&&prior.stageHash===stageHash&&prior.snapshot===job.snapshot)return prior.value;
 dropPlan(key);
 const directory=directoryLookup(base);
 const result=await require('./exchange-plan').plan(base,job,{staged,validateEntry,objectDirectory:(_,owner,category)=>directory(owner,category),signal});
 if(job.compatibility?.optionalDateFiles)result.summary.compatibility={optionalDateFiles:job.compatibility.optionalDateFiles};
 if(result.estimatedBytes<=PLAN_VIEW_LIMIT){while(planViews.size&&planViewBytes+result.estimatedBytes>PLAN_VIEW_LIMIT)dropPlan(planViews.keys().next().value);planViews.set(key,{value:result,bytes:result.estimatedBytes,jobToken,stageHash,snapshot:job.snapshot});planViewBytes+=result.estimatedBytes;}
 return result;
}
async function inspect(base,file,options={}){return require('./workspace-access').withAccess(base,'exclusive',()=>{assertIdle(base);indexLegacyRecovery(base);return inspectContents(base,file,options);});}
function existingProofHashes(dir, owner, kind) {
    const state = read(require('./incremental').stateFile(dir, kind));
    if (!state?.importedEvidence || state.schema !== 1 || state.uid !== owner.id || state.kind !== kind) return new Set();
    const refs = [state.proof,state.pending?.packets].filter(Array.isArray).flat();
    let link = state.connection;
    for (let n = 0; link && n < 65; n++) {
        if (!/^update-connections\/[a-f0-9-]{36}\.json$/.test(link.file || '')) break;
        const file = path.join(dir, 'cache', link.file);
        if (!fs.existsSync(file)) break;
        const bytes = require('./regular-file').read(file, { maxBytes: 16 * 1024 * 1024 });
        if (S.hash(bytes) !== link.hash) break;
        const connection = JSON.parse(bytes);
        if (connection.uid !== owner.id || connection.kind !== kind || !Array.isArray(connection.packets)) break;
        refs.push(...connection.packets);
        link = connection.previous;
    }
    return new Set(refs.filter(ref => ref?.envelope && ref.uid === owner.id && ref.kind === kind &&
        /^[a-f0-9]{64}$/.test(ref.hash || '') &&
        path.resolve(dir, ref.file || '') === path.join(E.folder(dir), ref.hash + '.json')).map(ref => ref.hash));
}
async function materialize(base, job, signal) {
    const checkpoint=require('./local-work').checkpoint(signal);let processed=0;
    const planned = await plan(base, job, signal),directory=directoryLookup(base),actions = [], writes = new Map(), now = new Date().toISOString(), writer=staging.writer(path.join(path.dirname(jobFile(base,job.id)),'blobs'),durable);
    try {
    function add(relative, bytes) { const target = safeFile(base, relative), h = S.hash(bytes), old = fs.existsSync(target) ? token(target) : 'absent'; if (old === h)
        return; writer.put(bytes,h); writes.set(relative, { path: relative, hash: h, before: old }); }
    function json(file, value) {if(fs.existsSync(file)&&S.stable(read(file))===S.stable(value))return;add(path.relative(base, file).split(path.sep).join('/'), Buffer.from(JSON.stringify(value))); }
    const store=require('./exchange-store'),merge=require('./exchange-merge'),native=require('./exchange-native'),documents=new Set(),nativeKeys=new Map(),changedScopes=new Set();
    function document(file,bytes){const h=S.hash(bytes);if(fs.existsSync(file)&&store.isReference(read(file))){if(S.hash(E.bytes(file))!==h)throw Error('共享内容引用与原始哈希不匹配');return;}if(!documents.has(h)){writer.put(bytes,h);actions.push({kind:'content',path:path.relative(base,store.database(base)),hash:h,bytes:bytes.length});documents.add(h);}add(path.relative(base,file).split(path.sep).join('/'),store.reference(bytes));}
    const localProofs = new Map(), userCategories = new Map();
    for (const { v } of planned.values) {
        await checkpoint();
        if (v.owner.kind !== 'user') continue;
        const categories = userCategories.get(v.owner.id) || new Set();
        categories.add(v.channel === 'user-posts' ? 'posts' : 'users');
        userCategories.set(v.owner.id, categories);
    }
    for (const { f, v:meta } of planned.values) {
        await checkpoint();
        if(meta.role!=='packet')continue;
        const o=f.owner,kind=meta.channel,dir=directory(o,kind==='user-posts'?'posts':o.kind==='post'?'post-comments':'user-comments'),scope=dir+'|'+kind;
        const file=path.join(E.folder(dir),f.sha256+'.json');
        if (!localProofs.has(scope)) {
            const refs = o.kind === 'user' && kind !== 'user-posts' ? existingProofHashes(dir, o, kind) : new Set();
            localProofs.set(scope, refs);
        }
        const required = localProofs.get(scope).has(f.sha256);
        if(fs.existsSync(file)){
            if(required&&S.hash(E.bytes(file))!==f.sha256)throw Error('已有进度引用的响应哈希不匹配，未覆盖原文件');
            continue;
        }
        // An identical native page cannot replace an exact envelope already referenced locally.
        if(!required){
            if(!nativeKeys.has(scope))nativeKeys.set(scope,native.keys(dir,o,kind));
            if(nativeKeys.get(scope).has(native.key(planned.readEntry(f))))continue;
        }
        document(file,staged(base,job,f));changedScopes.add(dir);
    }
    // One merged main row per typed ID/scope. Keep only genuinely conflicting
    // comment bodies (and editable post variants) as additional record evidence.
    const recordSets=new Map();
    for(const entry of planned.variants.values()){
        const {dir,owner,kind,row,existing,existingVersions,incoming}=entry;
        const key=dir+'|'+kind,rows=recordSets.get(key)||{dir,owner,kind,rows:[],seen:new Set(),retainedIds:new Set(),savedAt:entry.savedAt};
        if(Date.parse(entry.savedAt)<Date.parse(rows.savedAt))rows.savedAt=entry.savedAt;
        function retain(r){const h=merge.version(r,kind);if(rows.seen.has(h))return;rows.seen.add(h);rows.retainedIds.add(r.recordId);rows.rows.push(r);}
        if(entry.changed&&!(existingVersions?.has(merge.version(row,kind))&&!require('./record-body').completeBody(row))&&!merge.conflict(existing,row,kind)&&(!['user-posts','mentions-posts'].includes(kind)||existing||!entry.carriedInPacket))retain(entry.merged);
        for(const [h,r]of incoming)if(merge.conflict(existing||row,r,kind)&&!existingVersions?.has(h))retain(r);
        if(!existing&&!existingVersions?.has(merge.version(row,kind))&&!rows.retainedIds.has(row.recordId)&&(!['user-posts','mentions-posts'].includes(kind)||!entry.carriedInPacket))retain(row);
        recordSets.set(key,rows);
    }
    for(const r of recordSets.values())for(let i=0;i<r.rows.length;i+=500){const value={schema:1,role:'records',owner:r.owner,channel:r.kind,savedAt:r.savedAt,rows:r.rows.slice(i,i+500)},bytes=Buffer.from(S.stable(value)),h=S.hash(bytes),file=path.join(E.folder(r.dir),h+'.json');document(file,bytes);changedScopes.add(r.dir);}
    // Migrate only imported envelopes in changed scopes, retaining exact hashes
    // and paths. Native raw receipts remain untouched until separately proven safe.
    for(const dir of changedScopes)for(const e of E.iterateEntries(dir)){await checkpoint();const current=require('./regular-file').read(e.file,{maxBytes:LIMITS.file});if(!store.isReference(JSON.parse(current)))document(e.file,current);}
    const manifestOwners=new Map(job.manifest.objects.map(owner=>[S.key(owner),owner]));
    for (const f of job.manifest.files.filter(f => ['image', 'avatar'].includes(f.role))) {
        if (f.role === 'image') {
            const dir = directory(f.owner,f.category), target = path.join(dir, 'images', f.name);
            let dest = target;
            if (fs.existsSync(target) && token(target) !== f.sha256)
                dest = target.replace(/\.[^.]+$/, e => '_' + f.sha256.slice(0, 16) + e);
            add(path.relative(base, dest).split(path.sep).join('/'), staged(base, job, f));
        }
        else {
            const uid=f.profileUid||f.owner.id,dir=path.join(readerRoot(base),'profiles',uid),name=f.sha256+'.'+f.extension,target=path.join(dir,'identity.json'),old=read(target,{uid,status:'ready'}),object=manifestOwners.get(S.key(f.owner));
            const newer=Number.isFinite(Date.parse(object?.profileAt))&&(!Number.isFinite(Date.parse(old.remoteSucceededAt))||Date.parse(object.profileAt)>Date.parse(old.remoteSucceededAt));
            if(!old.avatarFile||newer){add(path.relative(base,path.join(dir,name)).split(path.sep).join('/'),staged(base,job,f));json(target,{...old,uid,nickname:newer?(object?.nickname||object?.author||old.nickname||''):(old.nickname||object?.nickname||object?.author||''),avatarFile:name,...(newer?{remoteSucceededAt:object.profileAt}:{})});}
        }
    }
    for(const o of job.manifest.objects){const uid=o.kind==='user'?o.id:o.authorUid;if(!uid)continue;const target=path.join(readerRoot(base),'profiles',uid,'identity.json'),old=read(target,null),name=o.kind==='user'?o.nickname:o.author;
        if(name&&Number.isFinite(Date.parse(o.profileAt))&&(!old||!Number.isFinite(Date.parse(old.remoteSucceededAt))||Date.parse(o.profileAt)>Date.parse(old.remoteSucceededAt))){const pending=writes.get(path.relative(base,target).split(path.sep).join('/'));const value=pending?JSON.parse(writer.get(pending.hash)):old||{uid,status:'ready'};json(target,{...value,uid,nickname:name,remoteSucceededAt:o.profileAt});}
    }
    // Bodies and evidence are committed before mutable identity/read/progress indexes.
    actions.push(...writes.values());
    writes.clear();
    const registered=new Set(require('../desktop/library').listAccounts(base).map(u=>u.uid));
    const indexes = new Map(), changedIndexes=new Set(), roots=storagePaths(base), users = read(path.join(readerRoot(base), 'users.json'), { schema: 1, users: {} }), posts = read(path.join(readerRoot(base), 'posts.json'), { schema: 1, posts: {} });
    for (const o of job.manifest.objects) {
        if (o.kind === 'user') {
            if (!users.users[o.id]&&!registered.has(o.id))
                users.users[o.id] = { uid: o.id, nickname: o.nickname || '用户 ' + o.id };
        }
        else if (!posts.posts[o.id])
            posts.posts[o.id] = { postId: o.id, title: o.title || '微博 ' + o.id, author: o.author || '', authorUid: o.authorUid || '' };
        if (o.kind === 'user')
            for (const category of userCategories.get(o.id)||[]) {
                const r = roots[category];
                if (!indexes.has(r))
                    indexes.set(r, indexRead(r));
                const index = indexes.get(r);
                if (!index[o.id]) {
                    index[o.id] = { folder: o.id, nickname: o.nickname || o.id };
                    changedIndexes.add(r);
                }
            }
    }
    for (const r of changedIndexes)json(path.join(r,'.account_names.json'),indexes.get(r));
    if(Object.keys(users.users).length)json(path.join(readerRoot(base), 'users.json'), users);
    if(Object.keys(posts.posts).length)json(path.join(readerRoot(base), 'posts.json'), posts);
    const preferences = new Map();
    for (const v of planned.variants.values()) {
        if(++processed%128===0)await checkpoint();
        if(!changedScopes.has(v.dir))continue;
        const f = path.join(E.folder(v.dir), 'preferred.json');
        let data = preferences.get(f);
        if (!data) {
            data = read(f, { schema: 1, records: {} });
            preferences.set(f, data);
        }
        const key = v.kind + ':' + v.row.recordId;
        if (!data.records[key])
            data.records[key] = merge.version(v.existing||v.row,v.kind);
    }
    for (const [f, v] of preferences)
        json(f, v);
    const boxes = new Map(),commentPresence=new Map(),commentCandidates=new Map();
    for(const e of planned.variants.values())if(e.owner.kind==='user'&&['sent','received'].includes(e.kind)&&!e.existing&&!e.row.isContext&&require('./record-body').completeBody(e.row)){
        const ids=commentCandidates.get(e.owner.id)||new Set();ids.add(e.row.recordId);commentCandidates.set(e.owner.id,ids);
    }
    async function alreadySavedComment(v){
        const initial=planned.localComments.get(v.owner.id);
        if(initial?.ids.has(v.row.recordId))return true;
        let known=commentPresence.get(v.owner.id);
        if(!known){
            const ids=new Set(initial?.ids||[]),kinds=['sent','received','mentions-comments'].filter(k=>!initial?.kinds.has(k));
            // Only IDs that would otherwise become newly unread need this
            // cross-direction lookup. Quotes and identically numbered posts
            // never count; source-specific progress is not consulted or changed.
            const wanted=new Set([...(commentCandidates.get(v.owner.id)||[])].filter(id=>!ids.has(id)));
            if(kinds.length&&wanted.size)for(const id of await require('./exchange-reading').existingCommentIds(v.dir,v.owner.id,kinds,wanted,{signal}))ids.add(id);
            known=ids;commentPresence.set(v.owner.id,known);
        }
        return known.has(v.row.recordId);
    }
    for (const v of planned.variants.values()) {
        if(++processed%128===0)await checkpoint();
        if(v.owner.kind==='post'&&v.kind==='post-comments'&&(!v.existing||!require('./record-body').completeBody(v.existing))&&!v.row.isContext&&require('./record-body').completeBody(v.row)){
            const reading=require('./post-reading-state'),f=reading.file(base,v.owner.id);let box=boxes.get(f);if(!box){box=reading.plan(base,v.owner.id);boxes.set(f,box);}if(!box.items[v.row.recordId])box.items[v.row.recordId]={id:v.row.recordId,firstSeenAt:now,readAt:null};continue;
        }
        if (v.owner.kind !== 'user' || !['sent', 'received'].includes(v.kind) || v.existing || v.row.isContext || !require('./record-body').completeBody(v.row))
            continue;
        const f = require('./follow-inbox').file(base, v.owner.id);
        let box = boxes.get(f);
        if (!box) {
            box = read(f, { schema: 1, uid: v.owner.id, items: {}, initializedAt: now, lastSent: null, lastReceived: null });
            if (box.schema !== 1 || box.uid !== v.owner.id || !box.items || typeof box.items !== 'object' || Array.isArray(box.items))
                throw Error('本机未读状态损坏，请先修复，未覆盖旧状态');
            boxes.set(f, box);
        }
        const row = v.row;
        if (!box.items[row.recordId]&&!await alreadySavedComment(v))
            box.items[row.recordId] = { id: row.recordId, ms: row.ms, group: v.kind, firstSeenAt: now, readAt: null };
        const k = v.kind === 'sent' ? 'lastSent' : 'lastReceived';
        if (!box[k] || row.ms > box[k].ms)
            box[k] = { id: row.recordId, ms: row.ms, time: row.time };
    }
    for (const [f, box] of boxes)
        json(f, box);
    actions.push(...writes.values());
    writer.seal();return { actions, summary: planned.summary };
    }finally{writer.close();dropPlan(jobFile(base,job.id));}
}
async function execute(base, job, { signal, inject = () => { } } = {}) {
    const dir = path.dirname(jobFile(base, job.id)),cursorFile=path.join(dir,'progress.json'),jobHash=token(jobFile(base,job.id)),saved=read(cursorFile);
    if(!saved)throw Error('旧合并缺少原始计划封印，已停止写入。请到设置→导入并合并，选择此事务原来的 .wrdpack 数据包重新检查并确认；已保存内容、旧事务与暂存证据保留');
    if(saved){if(saved.schema!==1||saved.id!==job.id||saved.jobHash!==jobHash||!Number.isSafeInteger(saved.next)||saved.next<job.next||saved.next>job.actions.length)throw Error('交换恢复进度与原始计划不一致');job.next=saved.next;}
    const checkpoint=()=>durable(cursorFile,Buffer.from(JSON.stringify({schema:1,id:job.id,jobHash,next:job.next})));
    for (let i = job.next; i < job.actions.length; i++) {
        if (signal?.aborted)
            throw Object.assign(Error('合并已中断，已保存事务；重新打开软件后继续恢复。'), { code: 'EXCHANGE_INTERRUPTED' });
        const a = job.actions[i];job.phase=a.kind==='content'?'save-content':'save-indexes';const target = safeFile(base, a.path);
        if(a.kind==='content'){
            const batch=[];let bytesTotal=0;for(let n=i;n<job.actions.length&&job.actions[n].kind==='content'&&batch.length<32;n++){
                const action=job.actions[n],bytes=staging.get(path.join(dir,'blobs'),action.hash);if(bytes.length!==action.bytes)throw Error('共享正文暂存长度损坏');batch.push({action,bytes,index:n});bytesTotal+=bytes.length;if(bytesTotal>=2*1024*1024)break;
            }
            for(const x of batch)inject('before-write',x.index,x.action);
            require('./exchange-store').putBatch(base,batch.map(x=>x.bytes));
            for(const x of batch)inject('after-write',x.index,x.action);
            job.next=i+batch.length;checkpoint();inject('after-checkpoint',job.next-1,batch.at(-1).action);i=job.next-1;await new Promise(setImmediate);continue;
        }
        // Older sealed plans may contain foreign checkpoint writes. Keep the
        // plan and all previously committed bytes, and skip remaining writes.
        if (/\/cache\/(?:updates|update-connections)\//.test(a.path)) {
            job.next = i + 1;
            checkpoint();
            continue;
        }
        const existing=fs.existsSync(target)?token(target):'absent';
        if (existing !== a.hash) {
            if (existing !== a.before)
                throw Error('本机文件在导入中变化；保留原文件及待恢复事务，未覆盖该文件');
            const bytes = staging.get(path.join(dir,'blobs'),a.hash);
            if (S.hash(bytes) !== a.hash)
                throw Error('事务暂存哈希损坏');
            inject('before-write', i, a);
            durable(target, bytes);
            inject('after-write', i, a);
        }
        job.next = i + 1;
        if(job.next%32===0){checkpoint();inject('after-checkpoint',i,a);}
        await new Promise(setImmediate);
    }
    job.status = 'committed';
    job.summary.noChanges=job.actions.length===0;
    job.finishedAt = new Date().toISOString();
    const compact={schema:1,id:job.id,status:'committed',finishedAt:job.finishedAt,packageHash:job.packageHash,summary:job.summary,compatibility:job.compatibility};
    writeJob(base, compact);
    fs.rmSync(cursorFile,{force:true});
    fs.rmSync(pendingFile(base), { force: true });
    try {
        fs.rmSync(path.join(dir, 'blobs'), { recursive: true, force: true });
    }
    catch { }
    require('./file-view-cache').clear();
    try {
    const completed=fs.readdirSync(path.dirname(dir)).filter(n=>/^[a-f0-9-]{36}$/.test(n)).map(n=>({n,v:read(path.join(path.dirname(dir),n,'job.json'))})).filter(e=>e.v?.status==='committed').sort((a,b)=>String(b.v.finishedAt).localeCompare(String(a.v.finishedAt)));
    const protectedJobs=new Set();for(const name of fs.readdirSync(path.dirname(dir)).filter(n=>/^[a-f0-9-]{36}$/.test(n))){const ref=read(path.join(path.dirname(dir),name,'reinspection.json'));if(ref?.schema===1)protectedJobs.add(ref.newId);}for(const old of completed.slice(32))if(!protectedJobs.has(old.n))fs.rmSync(path.join(path.dirname(dir),old.n),{recursive:true,force:true});
    } catch(error) {job.summary.warnings.push('数据合并已保存；旧事务清理未完成：'+error.message);try{writeJob(base,{...compact,summary:job.summary});}catch{}}
    return { ...job.summary, transactionId: job.id, completed: true, partial: job.summary.warnings.length > 0 };
}
async function commit(base, id, { signal, inject, onPhase } = {}) {
    if (!transactionId.test(id))
        throw Error('导入确认已失效');
    return require('./workspace-access').withAccess(base, 'exclusive', async () => {
        assertIdle(base);
        indexLegacyRecovery(base);
        let pointer = readPending(base);

        const job = read(jobFile(base, id));
        if (job?.schema !== 1)
            throw Error('导入暂存不存在');
        if(pointer&&pointer.id!==id){
            const review=job.reviewOf,prior=review&&read(jobFile(base,review.id));
            if(!review||review.id!==pointer.id||prior?.status!=='applying'||(fs.existsSync(path.join(path.dirname(jobFile(base,review.id)),'progress.json'))&&pointer.detachedLegacy!==true)||token(jobFile(base,review.id))!==review.jobHash||job.packageHash!==review.packageHash)throw Error('另一合并事务尚未恢复；请选择原数据包重新检查');
        }
        if(pointer?.id===id&&pointer.detachedLegacy===true)throw Error('旧合并未登记且可能早于本机新数据；请重新检查该事务原来的 .wrdpack 数据包并确认。旧事务和已保存数据均保留');
        if(!pointer&&job.status==='applying')throw Error('导入确认已失效，请重新检查原数据包');
        if (job.status === 'committed')
            return { ...job.summary, completed: true, reused: true, credits: 0 };
        if (job.status === 'inspected') {
            if (job.snapshot !== footprint(base, job.manifest.objects))
                throw Error('本地数据在检查后已变化，请重新检查数据包再确认合并');
            if (stamp(job.source) !== job.sourceStamp)
                throw Error('原数据包已改变，请重新检查');
            let prepared;try{prepared=await materialize(base,job,signal);}catch(error){require('./exchange-diagnostics').record(base,'import','merge-plan',error,durable,id);throw error;}
            const {actions,summary}=prepared;
            job.actions = actions;
            job.summary = summary;
            job.status = 'applying';
            job.next = 0;
            const planBytes=Buffer.from(JSON.stringify(job)),jobHash=S.hash(planBytes);
            durable(path.join(path.dirname(jobFile(base,job.id)),'progress.json'),Buffer.from(JSON.stringify({schema:1,id:job.id,jobHash,next:0})));
            if(!pointer){
                // Register before publishing the applying plan. An inspected
                // job can be retried, while every applying plan is discoverable.
                pointer={schema:1,id:job.id};
                durable(pendingFile(base),Buffer.from(JSON.stringify(pointer)));
            }
            durable(jobFile(base,job.id),planBytes);
        }
        if (job.status !== 'applying')
            throw Error('导入事务状态无效');
        if(pointer&&pointer.id!==id){
            // A fully verified fresh plan and its original seal now exist. Keep
            // all old bytes; never execute the unsafe old action list.
            const review=job.reviewOf;
            durable(path.join(path.dirname(jobFile(base,review.id)),'reinspection.json'),Buffer.from(JSON.stringify({schema:1,oldHash:review.jobHash,newId:id,packageHash:job.packageHash})));
        }
        if (!pointer||pointer.id!==id)
            durable(pendingFile(base), Buffer.from(JSON.stringify({ schema: 1, id: job.id })));
        try {
            onPhase?.('merging');
            return await execute(base, job, { signal, inject });
        }
        catch (error) {
            require('./exchange-diagnostics').record(base,'import',job.phase||'apply',error,durable,id);
            error.transactionId = job.id;
            throw error;
        }
    });
}
async function recover(base, { inject, signal } = {}) {
    if(!pending(base))return [];
    const recovery=require('./workspace-access').withAccess(base,'exclusive',()=>{
        indexLegacyRecovery(base);
        const pointer=readPending(base);
        if(!pointer)return null;
        let id=pointer.id, file=jobFile(base,id), job=read(file);
        if(job?.status==='applying'&&superseded(base,id)){
            const link=read(path.join(path.dirname(file),'reinspection.json'));
            id=link.newId;file=jobFile(base,id);job=read(file);
            durable(pendingFile(base),Buffer.from(JSON.stringify({schema:1,id})));
        }
        if(job?.status==='applying')return {id};
        if(!['committed','inspected'].includes(job?.status))throw Error('合并恢复事务缺失，未继续写入');
        fs.rmSync(pendingFile(base),{force:true});
        if(job.status==='committed'){
            fs.rmSync(path.join(path.dirname(file),'progress.json'),{force:true});
            fs.rmSync(path.join(path.dirname(file),'blobs'),{recursive:true,force:true});
        }
        indexLegacyRecovery(base);
        return readPending(base)?{again:true}:null;
    });
    if(recovery?.again)return recover(base,{inject,signal});
    if(!recovery?.id)return [];
    const results=[await commit(base,recovery.id,{inject,signal})];
    if(pending(base))results.push(...await recover(base,{inject,signal}));
    return results;
}
function discard(base, id) {
    if(typeof id!=='string'||!transactionId.test(id))throw Error('数据包检查编号无效');
    return require('./workspace-access').withAccess(base,'exclusive',()=>{
        const relative=path.relative(path.resolve(base),path.dirname(jobFile(base,id)));
        const folder=require('./workspace-access').directory(base,relative);
        const file=path.join(folder,'job.json'),job=read(file);
        if(!job)return;
        const progress=fs.lstatSync(path.join(folder,'progress.json'),{throwIfNoEntry:false});
        if(job.id!==id||job.status!=='inspected'||readPending(base)?.id===id||progress)
            throw Error('该检查已进入合并或恢复，暂存已保留');
        fs.rmSync(folder,{recursive:true,force:true});
        dropPlan(file);
    });
}
function pending(base) {
    const folder=root(base);
    try{fs.lstatSync(path.join(folder,'pending.json'));return true;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    return fs.existsSync(path.join(folder,'transactions'))&&!recoveryIndexed(folder);
}
module.exports = { FORMAT, MAGIC, LIMITS, objects, exportPackage, inspect, commit, recover, discard, pending, plan, validateManifest, validateEntry, footprint, assertIdle };
