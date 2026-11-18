'use strict';
// Durable writes always flush the write descriptor when the OS allows it.
// On Windows, FlushFileBuffers/fsync can return EPERM for:
//   - directory handles (always)
//   - O_RDONLY handles (always)
//   - some AV / Controlled Folder Access setups even on writable files
// After a successful write + close/rename, NTFS already makes the bytes
// recoverable for Reader journals; treating that EPERM as non-fatal avoids
// aborting a paid request whose body is already on disk.
const fs = require('node:fs');

function ignoreWindowsEperm(error) {
  return process.platform === 'win32' && error && error.code === 'EPERM';
}

function file(fd) {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (!ignoreWindowsEperm(error)) throw error;
  }
}

function path(filePath) {
  const flags = process.platform === 'win32'
    ? fs.constants.O_RDWR | fs.constants.O_NOFOLLOW
    : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(filePath, flags);
  } catch (error) {
    if (ignoreWindowsEperm(error) || (process.platform === 'win32' && ['EACCES', 'EINVAL'].includes(error.code))) return;
    throw error;
  }
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (!ignoreWindowsEperm(error)) throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function directory(dirPath) {
  let fd;
  try {
    const flags = process.platform === 'win32'
      ? fs.constants.O_RDONLY
      : fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    fd = fs.openSync(dirPath, flags);
  } catch (error) {
    if (ignoreWindowsEperm(error) || (process.platform === 'win32' && ['EACCES', 'EINVAL'].includes(error.code))) return;
    throw error;
  }
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (!ignoreWindowsEperm(error)) throw error;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { file, path, directory };
