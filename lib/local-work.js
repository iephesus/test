'use strict';
// Cooperative local CPU/file work only; never parallelizes a data commit or request.
const { performance } = require('node:perf_hooks');
function checkpoint(signal, sliceMs = 12) {
    let last = performance.now();
    return async function () {
        signal?.throwIfAborted();
        if (performance.now() - last < sliceMs) return;
        await new Promise(setImmediate);
        signal?.throwIfAborted();
        last = performance.now();
    };
}
module.exports = { checkpoint };
