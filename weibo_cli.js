#!/usr/bin/env node
'use strict';
// Public entrypoint; feature implementations live in lib/.
const modules=['core','storage','reader','user-comments','post-comments','user-posts','cli'];
const api=Object.assign({},...modules.map(name=>require('./lib/'+name)));
if(require.main===module)api.runMain();
module.exports=api;
