'use strict';

const { clean } = require('../lib/diagnostic-text');
const objectLimit = 100;
const warningLimit = 30;

function shorten(value, limit) {
    // Bound work before sanitizing and preserve whole Unicode code points.
    const points = Array.from(clean(value.slice(0, limit * 2 + 1)));
    return points.length > limit ? points.slice(0, limit).join('') + '…' : points.join('');
}

function summary(result) {
    const { added, duplicate, conflicts, contexts, incomplete, ignoredProgress, compatibility, warnings = [] } = result;
    return {
        added, duplicate, conflicts, contexts, incomplete, ignoredProgress,
        ...(compatibility ? { compatibility: { optionalDateFiles: compatibility.optionalDateFiles } } : {}),
        warningCount: warnings.length,
        credits: 0
    };
}

function preview({ id, summary: result }) {
    const { objects, warnings = [] } = result;
    return {
        id,
        summary: {
            ...summary(result),
            reinspection: result.reinspection === true,
            objectCount: objects.length,
            objects: objects.slice(0, objectLimit).map(({ kind, id, nickname, author, title }) => ({
                kind, id, label: shorten(nickname || author || title || id, 120)
            })),
            warnings: warnings.slice(0, warningLimit).map(text => shorten(text, 240))
        }
    };
}

function imported(result) {
    const { completed, reused, noChanges, partial } = result;
    return { ...summary(result), completed, reused, noChanges, partial };
}

module.exports = { preview, imported };
