import fs from 'node:fs';
import path from 'node:path';

// A console owns its data folder through this file. A second instance on the
// same database would overwrite the first one's saves, so it has to name the
// running console and stop instead of starting quietly.
const LOCK_NAME = 'console.lock';

export function lockPath(dataDir) {
  return path.join(dataDir, LOCK_NAME);
}

function readOwner(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err?.code === 'EPERM';
  }
}

/** Write the owner record through a temp file, so a reader never sees half of it. */
function writeOwner(file, owner) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(owner, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

/**
 * Take the data folder for this process, replacing a lock whose console is gone.
 * Returns { ok: true } when the folder is ours, or { ok: false, owner } naming
 * the console that already has it.
 */
export function claimDataFolder(dataDir, { port = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = lockPath(dataDir);
  const body = { pid: process.pid, port, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(body, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, owner: body };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const owner = readOwner(file);
      if (owner && owner.pid !== process.pid && isRunning(owner.pid)) {
        return { ok: false, owner };
      }
      // Written by a console that exited, or unreadable: take it over.
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  }
  return { ok: false, owner: readOwner(file) };
}

/** Record the port that actually bound, for the console the folder belongs to. */
export function updateDataLock(dataDir, port) {
  const file = lockPath(dataDir);
  const owner = readOwner(file);
  if (owner?.pid !== process.pid) return false;
  writeOwner(file, { ...owner, port });
  return true;
}

/** Drop the lock, but only if this process still owns it. */
export function releaseDataFolder(dataDir) {
  const file = lockPath(dataDir);
  const owner = readOwner(file);
  if (owner && owner.pid !== process.pid) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
