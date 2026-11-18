'use strict';
// Public SemVer may include a release-candidate suffix. Apple's marketing version
// remains numeric; the separate build number advances independently of that name.
function appVersion(pkg){
 const version=String(pkg.version||''),match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.exec(version);
 if(!match)throw Error('应用版本格式无效');
 if(!Number.isSafeInteger(pkg.buildNumber)||pkg.buildNumber<1)throw Error('应用 buildNumber 必须为正整数');
 return {version,release:match.slice(1,4).join('.'),build:String(pkg.buildNumber)};
}
module.exports={appVersion};
