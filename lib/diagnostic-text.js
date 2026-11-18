'use strict';

// Clean text before sending it to the desktop or recording a diagnostic.
const clean = value => String(value ?? '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\b(?:at_|rt_)[a-zA-Z0-9._-]{16,}/g, '[凭据已隐藏]');

module.exports = { clean };
