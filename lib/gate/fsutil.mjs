// Bounded file helpers: capped reads, text of a regular file, binary check, atomic private write.
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { writePrivate } from '../../hooks/projects.mjs';
import { MAX_FILE } from './env.mjs';

export function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// First MAX_FILE bytes of a regular file; never follows a symlink or blocks on a pipe.
// -> { buf, partial } | { skip: 'symlink' | 'missing' | 'unreadable' | 'other' }
export function readCapped(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const c = err && err.code;
    return { skip: c === 'ELOOP' ? 'symlink' : c === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { skip: 'other' };
    const n = Math.min(st.size, MAX_FILE);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got);
      if (r <= 0) break;
      got += r;
    }
    return { buf: buf.subarray(0, got), partial: st.size > MAX_FILE };
  } catch {
    return { skip: 'unreadable' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

export function readSmall(file) {
  const r = readCapped(file);
  return r.buf && !r.partial ? r.buf : null;
}

// Text of a file; null when missing, unreadable, over max bytes or not a regular file (a FIFO never blocks us).
export function readText(file, max = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Atomic, 0600, folders 0700. Throws (code ESYMLINK) rather than write through a symlink: the file
// itself always, its folder too with guardDir (the run folder, a project's .jefe).
export function writeAtomic(file, text, guardDir = false) {
  writePrivate(file, text, { guardDir });
}
