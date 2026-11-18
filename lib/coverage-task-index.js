'use strict';
// Disposable task summaries for timeline display. Never consumed by acquisition,
// resume or checkpoint validation; raw tasks and response proofs remain authority.
const fs = require('node:fs');
const path = require('node:path');
const views = require('./file-view-cache');
const regular = require('./regular-file');
const {hash} = require('./local-corpus');
const metrics = {sourceReads: 0, indexReads: 0};
const maxBytes = 64 * 1024 * 1024;
function pick(value, keys) {
    return Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
}
function project(value) {
    if (value?.schema !== 1 || !value.query || !/^[a-f0-9-]{36}$/.test(value.id || '')) throw Error('任务格式无法解释');
    const task = pick(value, ['schema', 'id', 'uid', 'status', 'pid', 'startedAt', 'finishedAt', 'resumedBy']);
    if(task.startedAt!=null&&typeof task.startedAt!=='string')throw Error('任务日期无法解释');task.startedAt ||= '';
    task.query = pick(value.query, ['target', 'mode', 'limit', 'unlimited', 'from', 'to', 'before', '_scopeId']);
    task.summary = {sources: (value.summary?.sources || []).map(source => ({
        ...pick(source, ['kind', 'budget', 'fetched', 'ended', 'failed', 'cancelled', 'coverageUnverified', 'beforeMs', 'located', 'autoFollow', 'returnLimited', 'quickOnly', 'resumePending', 'pendingNew', 'partial', 'complete', 'running', 'reason', 'unknownTimeIds', 'missingBodyIds', 'incompleteReplies']),
        readProgress: pick(source.readProgress, ['pending', 'targetCovered', 'pendingNew', 'deltaConnected', 'covered', 'status', 'from', 'to', 'lastAttemptAt']),
        update: source.update ? pick(source.update, ['caughtUp', 'limited', 'newCount']) : undefined,
        completeness: pick(source.completeness, ['missingKnownIds'])
    }))};
    return task;
}
async function tasks(base, {signal} = {}) {
    const root = path.join(require('./data-layout').readerRoot(base), 'manual-tasks');
    const manifest = views.manifest(root, {filter: /^[a-f0-9-]{36}\.json$/});
    const index = path.join(require('./data-layout').readerRoot(base), 'indexes/coverage-v1/tasks.json');
    let previous = {}, valid = false;
    try {
        const stamp = views.regularStamp(index);
        if (stamp && stamp.size <= maxBytes) {
            previous = views.memo('coverage-task-index\0'+index, stamp.signature, () => {
                const box = JSON.parse(regular.read(index, {maxBytes})); metrics.indexReads++;
                if (box.schema !== 1 || !box.files || box.hash !== hash(box.files)) throw Error('任务摘要无效');
                return box.files;
            });
            valid = views.regularStamp(index)?.signature === stamp.signature;
            if (!valid) previous = {};
        }
    } catch {}
    const files = {}, warnings = [], tick = require('./local-work').checkpoint(signal, 6);
    let changed = !valid;
    for (const file of manifest.files) {
        await tick();
        const name = path.basename(file.file), old = previous[name];
        if (old?.signature === file.signature) files[name] = old;
        else {
            changed = true; metrics.sourceReads++;
            try {files[name] = {signature: file.signature, task: project(JSON.parse(regular.read(file.file, {maxBytes}))) };}
            catch (error) {files[name] = {signature: file.signature, task: null, warning: name + '：' + error.message};}
            if (views.regularStamp(file.file)?.signature !== file.signature) throw Error('原任务正在保存，请刷新时间轴');
        }
        if (files[name].warning) warnings.push(files[name].warning);
    }
    if (views.manifest(root, {filter: /^[a-f0-9-]{36}\.json$/}).signature !== manifest.signature) throw Error('原任务发生变化，请刷新时间轴');
    changed ||= Object.keys(previous).length !== Object.keys(files).length;
    if (changed) try {require('./update-progress').atomic(index, {schema: 1, files, hash: hash(files)});}
    catch (error) {warnings.push('任务摘要未保存：' + error.message);}
    signal?.throwIfAborted();
    // Reuse the actual task interpreter, including dead-process/running status.
    const result = require('../desktop/user-workspace').tasks(base, {readTask: file => structuredClone(files[path.basename(file)]?.task)});
    return {tasks: result, warnings};
}
module.exports = {tasks, project, metrics};
