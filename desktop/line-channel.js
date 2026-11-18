'use strict';
// A log can be truncated; a structured event must be delivered whole or rejected.
// Drop oversized lines until their newline so a suffix cannot become a new event.
function readLines(stream, onLine, { limit = 1024 * 1024, onOverflow = () => {} } = {}) {
  let pending = '', bytes = 0, dropping = false;
  stream.setEncoding('utf8');
  function segment(value, end) {
    if (!dropping) {
      const size = Buffer.byteLength(value);
      if (bytes + size > limit) {
        dropping = true;
        const prefix = (pending + value).slice(0, 8192);
        pending = ''; bytes = 0;
        onOverflow(prefix);
      } else { pending += value; bytes += size; }
    }
    if (end) {
      if (!dropping) onLine(pending);
      pending = ''; bytes = 0; dropping = false;
    }
  }
  stream.on('data', chunk => {
    let start = 0, newline;
    while ((newline = chunk.indexOf('\n', start)) >= 0) {
      segment(chunk.slice(start, newline), true); start = newline + 1;
    }
    if (start < chunk.length) segment(chunk.slice(start), false);
  });
  stream.on('end', () => { if (pending && !dropping) onLine(pending); pending = ''; bytes = 0; });
}
module.exports = { readLines };
