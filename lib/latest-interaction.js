'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { exactId } = require('./completeness');
const { completeBody } = require('./record-body');

const supported = kind => kind === 'sent' || kind === 'received';
const file = (dir, kind) => path.join(dir, 'cache/latest-interaction', kind + '.json');

function point(row, kind, uid) {
    const id = exactId(row?.recordId);
    if (!id || (row.group!==kind && !(row.group==='both'&&row.directions?.includes(kind))) || !completeBody(row) || !Number.isFinite(row.ms) ||
        (kind === 'sent' && row.authorUid !== uid)) return null;
    return { id, ms: row.ms };
}

function newer(best, next) {
    return next && (!best || next.ms > best.ms ||
        (next.ms === best.ms && BigInt(next.id) > BigInt(best.id))) ? next : best;
}

function read(dir, kind, uid) {
    const target = file(dir, kind);
    if (!fs.existsSync(target)) return null;
    const value = JSON.parse(require('./regular-file').read(target, { maxBytes: 16384 }));
    if (value.schema !== 1 || value.uid !== uid || value.kind !== kind ||
        !Number.isFinite(Date.parse(value.checkedAt)) ||
        (value.point !== null && (!value.point?.id || exactId(value.point.id)!==value.point.id || !Number.isFinite(value.point.ms))))
        throw Error('最新互动对照点无法核实，原证据已保留');
    return value;
}

function comparison(dir, kind, uid, archive, state) {
    const saved = read(dir, kind, uid);
    // Checkpoints imported by older releases are retained as history and cannot
    // initialize a direction. A subsequent native check supplies local evidence.
    const native = state?.checkedAt && !state.baselineUnverified && !state.importedEvidence;
    const observation = require('./subscription-latest').observedHead(dir, kind, uid);
    if (!saved?.point && !native && !observation) return null;
    const byId = id => point(archive.get(id)?.row, kind, uid);
    let result = saved?.point ? byId(saved.point.id) : null;
    if (native) {
        result = newer(result, byId(state.anchor));
        result = newer(result, byId(state.pending?.head));
    }
    if (observation) result = newer(result, byId(observation));
    // The archive has already merged committed imported bodies in the exact
    // channel. Dated native history cannot independently move this boundary.
    if (result) for (const entry of archive.values())
        if (entry.provenance?.exchange) result = newer(result, point(entry.row, kind, uid));
    if (result) {
        const fromSaved = saved?.point?.id === result.id;
        const fromIndependentObservation = observation === result.id || !!saved?.point && result.id === state?.anchor;
        const outsideCheckpoint = result.id !== state?.anchor && result.id !== state?.pending?.head;
        return {...result, external: fromSaved ? saved.point.external === true : fromIndependentObservation || outsideCheckpoint};
    }
    return native && exactId(state.anchor) ? { id: state.anchor, ms: -Infinity } : null;
}

function remember(dir, kind, uid, observed, {success=false,external=false}={}) {
    const previous = read(dir, kind, uid);
    const selected = newer(previous?.point || null, observed && {...observed,...(external?{external:true}:{})});
    const checkedAt = new Date().toISOString();
    require('./incremental').atomicJson(file(dir, kind), {
        schema: 1, uid, kind, checkedAt, point: selected,
        successfulAt: success ? checkedAt : previous?.successfulAt || null
    });
}

module.exports = { supported, point, newer, comparison, remember, read };
