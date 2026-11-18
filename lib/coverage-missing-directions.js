'use strict';

const path = require('node:path');
const views = require('./file-view-cache');
const regular = require('./regular-file');
const {rawArray, apiError, userId} = require('./core');
const {exactId} = require('./completeness');
const {hash} = require('./local-corpus');
const {sameJSON} = require('./exchange-schema');
const inventory = require('./inventory-sources');
const store = require('./exchange-store');

const directions = ['sent', 'received'];
const maxSource = 64 * 1024 * 1024;
const maxRun = 16 * 1024 * 1024;
const digest = /^[a-f0-9]{64}$/;

function read(file, expected, maxBytes) {
    const before = views.regularStamp(file);
    if (!before || expected && before.signature !== expected) throw Error('原证据已变化');
    const bytes = regular.read(file, {maxBytes});
    if (views.regularStamp(file)?.signature !== before.signature) throw Error('原证据已变化');
    return bytes;
}

function missingIds(packet, kind) {
    const parsed = rawArray(packet, kind);
    if (!parsed || apiError(packet)) return [];
    const values = parsed.container.miss_ids_str ?? parsed.container.miss_ids;
    return Array.isArray(values) ? values : [];
}

function formalIds(packet, kind, uid) {
    const parsed = rawArray(packet, kind);
    if (!parsed || apiError(packet)) return [];
    return parsed.items.filter(row => row && !row.isContext && (kind !== 'sent' || userId(row.user) === uid)).map(row => row.idstr ?? row.id ?? row.mid);
}

function validQuery(q, uid) {
    return q?.uid === uid && directions.includes(q.kind) && typeof q.taskId === 'string' && !!q.taskId &&
        Number.isSafeInteger(q.count) && q.count > 0 && Number.isSafeInteger(q.page) && q.page > 0 &&
        [q.maxId, q.sinceId].every(id => typeof id === 'string' && (!id || exactId(id) === id));
}

function receiptPacket(entry, bytes, uid) {
    const box = JSON.parse(bytes), q = box.query;
    if (box.schema !== 1 || !validQuery(q, uid)) return null;
    const requestFile = entry.file.replace(/\.response\.json$/, '.request.json');
    let request;
    if (views.regularStamp(requestFile)) {
        request = JSON.parse(read(requestFile, null, 256 * 1024));
        if (request.schema !== 1 || !sameJSON(request.query, q) || request.status === 'not-sent' ||
            request.responseFile && request.responseFile !== path.basename(entry.file)) return null;
    }
    if (box.receivedFile || box.receivedHash) {
        const receivedFile = entry.file.replace(/\.response\.json$/, '.received.json');
        if (!request || box.receivedFile !== path.basename(receivedFile) || !digest.test(box.receivedHash || '')) return null;
        const receivedBytes = read(receivedFile, null, maxSource), received = JSON.parse(receivedBytes);
        if (received.schema !== 1 || box.receivedHash !== hash(receivedBytes) || request.receivedHash && request.receivedHash !== box.receivedHash ||
            request.receivedFile && request.receivedFile !== box.receivedFile || received.savedAt !== box.savedAt || !sameJSON(received.query, q) ||
            received.queryHash !== hash(JSON.stringify(received.query)) || typeof received.responseText !== 'string' ||
            received.responseTextHash !== hash(received.responseText) || !sameJSON(box.response, JSON.parse(received.responseText))) return null;
    }
    return {kind: q.kind, packet: box.response};
}

function verifiedExchange(entry, bytes, uid) {
    let value = JSON.parse(bytes);
    if (store.isReference(value)) {
        if (value.bytes > maxSource) throw Error('来源超过 64 MB');
        bytes = store.read(entry.file, bytes);value = JSON.parse(bytes);
    }
    if (hash(bytes) !== path.basename(entry.file, '.json') || value.schema !== 1 || value.owner?.kind !== 'user' ||
        value.owner.id !== uid || !directions.includes(value.channel)) return null;
    const kind = value.channel;
    // A legacy cache can be exported with a guessed channel and a valid hash.
    // Only an imported request with independently verified provenance can assign it.
    if (value.role !== 'packet' || value.trusted !== true || value.query?.uid !== uid || value.query.kind !== kind) return null;
    require('./exchange-records').validatePacket(value);
    return {kind, packet: value.response};
}

function runDirections(run, uid) {
    if (run.schema !== 1 || run.uid !== uid || !Number.isFinite(Date.parse(run.createdAt)) || !Array.isArray(run.endpoints)) return [];
    const mode = require('./config').COMMANDS[run.mode] || run.mode;
    if (!directions.includes(mode) && !['both', 'all'].includes(mode)) return [];
    return run.endpoints.filter(endpoint => directions.includes(endpoint?.kind) &&
        (mode === endpoint.kind || mode === 'both' || mode === 'all') && Array.isArray(endpoint.packets));
}

async function legacyReferences(runs, hits, owner, tick) {
    const refs = new Map();let skipped = 0;
    const add = (relative, ref, kind) => {
        const hit = hits.get(relative);
        if (!hit) return;
        const matches = ref.missingIds.map(exactId).filter(id => hit.ids.has(id));
        if (!matches.length) return;
        let byHash = refs.get(relative);
        if (!byHash) refs.set(relative, byHash = new Map());
        let selected = byHash.get(ref.responseHash);
        if (!selected) byHash.set(ref.responseHash, selected = {kind, ids: new Set()});
        for (const id of matches) selected.ids.add(id);
    };
    for (const run of runs) {
        await tick();
        try {
            const value = JSON.parse(read(run.file, run.signature, maxRun));
            for (const endpoint of runDirections(value, owner.id)) for (const ref of endpoint.packets) {
                if (ref?.type !== 'api' || ref.cached !== false || ref.kind !== endpoint.kind || !digest.test(ref.responseHash || '') ||
                    !Array.isArray(ref.missingIds) || !/^cache\/[a-z0-9_.-]+\.json$/i.test(ref.file || '')) continue;
                const relative = ref.file.slice('cache/'.length);
                if (inventory.sourceKind(relative, owner) !== endpoint.kind) continue;
                add(relative, ref, endpoint.kind);
                add(relative.replace(/\.json$/, '_legacy_' + ref.responseHash.slice(0, 16) + '.json'), ref, endpoint.kind);
            }
        } catch {skipped++;}
    }
    return {refs, skipped};
}

async function classify(owner, candidates, runs, opts = {}) {
    const counts = {sent: 0, received: 0, unconfirmed: 0, total: candidates.ids.size};
    if (!counts.total) return {counts, warnings: candidates.warnings};
    const tick = require('./local-work').checkpoint(opts.signal, 6), assigned = new Map();
    const add = (kind, values, hit, subset = hit.ids) => {
        const bit = kind === 'sent' ? 1 : 2;
        for (const value of values) {
            const id = exactId(value);
            if (hit.ids.has(id) && subset.has(id)) assigned.set(id, (assigned.get(id) || 0) | bit);
        }
    };
    const rawHits = new Map([...candidates.hits].filter(([relative]) => directions.includes(inventory.sourceKind(relative, owner))));
    const legacy = rawHits.size ? await legacyReferences(runs, rawHits, owner, tick) : {refs: new Map(), skipped: 0};
    let skipped = legacy.skipped;
    for (const [relative, entry] of candidates.hits) {
        await tick();
        const role = inventory.sourceKind(relative, owner), refs = legacy.refs.get(relative);
        if (!refs && !['receipt', 'exchange'].includes(role)) continue;
        try {
            const bytes = read(entry.file, entry.signature, maxSource);
            if (refs) {
                const proof = refs.get(hash(bytes));
                if (proof) add(proof.kind, missingIds(JSON.parse(bytes), proof.kind), entry, proof.ids);
                continue;
            }
            const proof = role === 'receipt' ? receiptPacket(entry, bytes, owner.id) : verifiedExchange(entry, bytes, owner.id);
            if (!proof) continue;
            add(proof.kind, missingIds(proof.packet, proof.kind), entry);
            if (proof.packet) add(proof.kind, formalIds(proof.packet, proof.kind, owner.id), entry);
        } catch {skipped++;}
    }
    for (const id of candidates.ids) {
        const flags = assigned.get(id);
        counts[flags === 1 ? 'sent' : flags === 2 ? 'received' : 'unconfirmed']++;
    }
    const warnings = [...candidates.warnings];
    if (skipped) warnings.push(`${skipped} 份方向证据无法核实，未用作归类。`);
    return {counts, warnings};
}

module.exports = {classify};
