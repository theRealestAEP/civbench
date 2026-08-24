// A read-only filesystem mount for the agent sandbox (docs/PLAN.md §9.1).
//
// tinysandbox ships `local` mounts, but only its S3 backend has a readOnly flag. The agent's
// /run mount holds its dump and its history, and it must not be able to edit either: a doctored
// record would corrupt the benchmark as surely as a fog leak would. So we implement the JsVfs
// interface over node:fs and answer EACCES to every mutation.
//
// Path handling mirrors tinysandbox's own local mount: everything resolves strictly beneath the
// root, `..` cannot escape, and symlinks are never followed.
import { closeSync, openSync, readSync, realpathSync, statSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { JsVfs, VfsRequest, VfsResponse, DirEntryJs } from "@tinysandbox/tinysandbox";

const denied = (): VfsResponse => ({ error: { code: "EACCES", message: "read-only mount" } });
const missing = (): VfsResponse => ({ error: { code: "ENOENT", message: "no such file" } });

export function createReadOnlyVfs(root: string): JsVfs {
  const realRoot = realpathSync(root);
  let nextHandle = 1;
  const handles = new Map<number, number>(); // our handle -> fd

  /** Resolve a sandbox path beneath the root, or null if it escapes or is a symlink. */
  function hostPath(path: string | undefined): string | null {
    const candidate = resolve(realRoot, "." + (path?.startsWith("/") ? path : `/${path ?? ""}`));
    if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) return null;
    try {
      // realpath resolves symlinks; if the result leaves the root, refuse it.
      const real = realpathSync(candidate);
      return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
    } catch {
      return null;
    }
  }

  return {
    stat(req: VfsRequest): VfsResponse {
      const p = hostPath(req.path);
      if (!p) return missing();
      try {
        const s = statSync(p);
        return { fileType: s.isDirectory() ? "directory" : "file", len: s.size };
      } catch {
        return missing();
      }
    },

    readdir(req: VfsRequest): DirEntryJs[] | VfsResponse {
      const p = hostPath(req.path);
      if (!p) return missing();
      try {
        return readdirSync(p, { withFileTypes: true }).map((e) => {
          const child = join(p, e.name);
          let len = 0;
          try { len = statSync(child).size; } catch { /* raced away */ }
          return { name: e.name, fileType: e.isDirectory() ? "directory" : "file", len };
        });
      } catch {
        return missing();
      }
    },

    open(req: VfsRequest): number | VfsResponse {
      // OpenModeJs is a set of flags, not a string. Refuse anything that could mutate.
      const mode = req.mode;
      if (mode && (mode.write || mode.create || mode.createNew || mode.truncate || mode.append)) {
        return denied();
      }
      const p = hostPath(req.path);
      if (!p) return missing();
      try {
        const fd = openSync(p, "r");
        const handle = nextHandle++;
        handles.set(handle, fd);
        return handle;
      } catch {
        return missing();
      }
    },

    readAt(req: VfsRequest): Buffer | VfsResponse {
      const fd = handles.get(req.handle ?? -1);
      if (fd === undefined) return { error: { code: "EBADF" } };
      const len = req.len ?? 0;
      const buf = Buffer.allocUnsafe(len);
      const read = readSync(fd, buf, 0, len, req.offset ?? 0);
      return buf.subarray(0, read);
    },

    close(req: VfsRequest): void {
      const fd = handles.get(req.handle ?? -1);
      if (fd === undefined) return;
      handles.delete(req.handle!);
      try { closeSync(fd); } catch { /* already gone */ }
    },

    stats(): VfsResponse {
      return { usedBytes: 0, fileCount: 0 };
    },

    // Every mutation is refused. This is the whole point of the mount.
    mkdir: denied,
    rename: denied,
    unlink: denied,
    rmdir: denied,
    writeAt: denied,
    truncate: denied,
  };
}
