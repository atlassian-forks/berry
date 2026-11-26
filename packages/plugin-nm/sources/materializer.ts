import {Configuration} from '@yarnpkg/core';
import {NativePath}    from '@yarnpkg/fslib';
import {Worker}        from 'worker_threads';

/**
 * Writing a package into node_modules takes one syscall per file (link,
 * mkdir, chmod, symlink). Each one is cheap, but there are hundreds of
 * thousands of them in a large project, and making them one at a time from the
 * main thread (or through the libuv threadpool, one round-trip per call) leaves
 * most of the machine idle. A materializer makes these calls synchronously from
 * several worker threads instead.
 *
 * It only handles the cases that need nothing but the filesystem:
 *
 * - linking a package from the global hardlinks store, following its index;
 * - writing a package whose files the main thread read from its archive;
 * - cloning a package that was already written somewhere else in node_modules;
 * - removing a package from node_modules.
 *
 * Anything else (fetching from the archive, verifying or repairing the store)
 * stays on the main thread.
 */
export class Materializer {
  private readonly workers: Array<{worker: Worker, pending: Set<number>, error: Error | null}> = [];
  private readonly callbacks = new Map<number, {resolve: (done: boolean) => void, reject: (error: Error) => void}>();
  private nextId = 0;

  /**
   * Follows the settings of Yarn's other worker pools (`taskPoolMode`,
   * `taskPoolConcurrency`). Returns null when the work should stay on the
   * main thread, in which case the callers use their regular code path.
   */
  static create(configuration: Configuration) {
    // The worker code doesn't implement Windows junctions (see `symlinkPromise`)
    if (process.platform === `win32` || configuration.get(`taskPoolMode`) !== `workers`)
      return null;

    // A few threads are enough to saturate the filesystem
    const size = Math.min(configuration.get(`taskPoolConcurrency`), 8);
    if (size < 2)
      return null;

    return new Materializer(size);
  }

  private constructor(public readonly size: number) {
  }

  // The workers are only started once there's something for them to do
  private startWorkers() {
    const source = `(${materializerWorker.toString()})(require('worker_threads').parentPort, require('fs'), require('path'))`;

    for (let t = 0; t < this.size; ++t) {
      const worker = new Worker(source, {eval: true});
      const slot: Materializer[`workers`][number] = {worker, pending: new Set(), error: null};

      worker.on(`message`, ({id, done, error}: MaterializerResponse) => {
        slot.pending.delete(id);

        const callbacks = this.callbacks.get(id);
        if (typeof callbacks === `undefined`)
          return;

        this.callbacks.delete(id);

        if (typeof error !== `undefined`) {
          callbacks.reject(Object.assign(new Error(error.message), {code: error.code}));
        } else {
          callbacks.resolve(done);
        }
      });

      // A worker that crashed fails what it was doing, and isn't given anything else
      const onCrash = (error: Error) => {
        slot.error ??= error;

        for (const id of slot.pending) {
          this.callbacks.get(id)?.reject(slot.error);
          this.callbacks.delete(id);
        }

        slot.pending.clear();
      };

      worker.on(`error`, onCrash);
      worker.on(`exit`, code => onCrash(new Error(`Materializer worker exited unexpectedly (code ${code})`)));

      this.workers.push(slot);
    }
  }

  /**
   * Links a package from the global hardlinks store. Resolves to `false`,
   * without having written anything, if the store can't be used as it is
   * (no index, missing or possibly modified files); the regular code path then
   * takes over, and verifies or repairs the store.
   */
  linkFromStore(opts: {dstDir: NativePath, indexPath: NativePath, storePath: NativePath, mtimeAccuracy: number}) {
    return this.run({kind: `store`, ...opts});
  }

  /**
   * Writes files read from a package archive, in order (directories come
   * before what they contain). The content buffers are transferred to the
   * worker, so they must not be used afterwards.
   */
  async write(opts: {dstDir: NativePath, entries: Array<MaterializerWriteEntry>}) {
    const transferList = opts.entries.flatMap(entry => entry.kind === `file` ? [entry.content.buffer as ArrayBuffer] : []);
    await this.run({kind: `write`, ...opts}, transferList);
  }

  /**
   * Hardlinks (or copies, if `link` is false) every file of a package that was
   * already written in node_modules, except for its own node_modules and
   * `.bin` folders.
   */
  async clone(opts: {srcDir: NativePath, dstDir: NativePath, link: boolean}) {
    await this.run({kind: `clone`, ...opts});
  }

  /**
   * Same as `removeDir` in NodeModulesLinker.
   */
  async remove(opts: {dir: NativePath, contentsOnly: boolean, isWorkspaceDir: boolean}) {
    await this.run({kind: `remove`, ...opts});
  }

  async destroy() {
    await Promise.all(this.workers.map(({worker}) => {
      worker.removeAllListeners(`exit`);
      return worker.terminate();
    }));
  }

  private run(request: MaterializerRequestData, transferList: Array<ArrayBuffer> = []) {
    if (this.workers.length === 0)
      this.startWorkers();

    let slot: Materializer[`workers`][number] | null = null;
    for (const candidate of this.workers)
      if (candidate.error === null && (slot === null || candidate.pending.size < slot.pending.size))
        slot = candidate;

    if (slot === null)
      return Promise.reject(this.workers[0].error);

    const id = this.nextId++;
    slot.pending.add(id);

    return new Promise<boolean>((resolve, reject) => {
      this.callbacks.set(id, {resolve, reject});
      try {
        slot.worker.postMessage({id, ...request} satisfies MaterializerRequest, transferList);
      } catch (error) {
        slot.pending.delete(id);
        this.callbacks.delete(id);
        reject(error);
      }
    });
  }
}

export type MaterializerWriteEntry = {
  relativePath: string;
  kind: `file`;
  mode: number;
  content: Uint8Array;
} | {
  relativePath: string;
  kind: `directory`;
} | {
  relativePath: string;
  kind: `symlink`;
  symlinkTo: string;
};

type MaterializerRequestData = {
  kind: `store`;
  dstDir: NativePath;
  indexPath: NativePath;
  storePath: NativePath;
  mtimeAccuracy: number;
} | {
  kind: `clone`;
  srcDir: NativePath;
  dstDir: NativePath;
  link: boolean;
} | {
  kind: `write`;
  dstDir: NativePath;
  entries: Array<MaterializerWriteEntry>;
} | {
  kind: `remove`;
  dir: NativePath;
  contentsOnly: boolean;
  isWorkspaceDir: boolean;
};

type MaterializerRequest = MaterializerRequestData & {id: number};

type MaterializerResponse = {
  id: number;
  done: boolean;
  error?: {message: string, code?: string};
};

type StoreIndexEntry = {
  kind: `file`;
  mode: number;
  digest?: string;
  mtimeMs?: number;
} | {
  kind: `directory`;
} | {
  kind: `symlink`;
  symlinkTo: string;
};

// Runs in the worker threads, from its source: it must not reference anything but its parameters
function materializerWorker(parentPort: import('worker_threads').MessagePort, fs: typeof import('fs'), path: typeof import('path')) {
  const linkFromStore = ({dstDir, indexPath, storePath, mtimeAccuracy}: {dstDir: string, indexPath: string, storePath: string, mtimeAccuracy: number}) => {
    let entries: Array<[string, StoreIndexEntry]>;
    try {
      entries = Object.entries(JSON.parse(fs.readFileSync(indexPath, `utf8`)));
    } catch {
      return false;
    }

    // Same check as the main thread does before linking a file from the store, except that we don't repair
    // anything: if a single file isn't known to be intact, the whole package is left to the main thread
    const contentPaths: Array<string | null> = [];
    for (const [, entry] of entries) {
      if (entry.kind === `file`) {
        if (!entry.digest || !entry.mtimeMs)
          return false;

        const contentPath = path.join(storePath, entry.digest.substring(0, 2), `${entry.digest.substring(2)}.dat`);

        let stats;
        try {
          stats = fs.statSync(contentPath);
        } catch {
          return false;
        }

        if (stats.mtimeMs > entry.mtimeMs || stats.mtimeMs < entry.mtimeMs - mtimeAccuracy)
          return false;

        contentPaths.push(contentPath);
      } else if (entry.kind === `directory` || entry.kind === `symlink`) {
        contentPaths.push(null);
      } else {
        return false;
      }
    }

    const createdFiles: Array<string> = [];
    const createdDirs: Array<string> = [];

    // Records every directory it creates (a scope folder too), so that undoing removes the empty ones
    const mkdir = (dir: string) => {
      const firstCreated = fs.mkdirSync(dir, {recursive: true});
      if (typeof firstCreated === `undefined`)
        return;

      const created = [dir];
      for (let parent = path.dirname(dir); parent.length >= firstCreated.length && parent !== created[created.length - 1]; parent = path.dirname(parent))
        created.push(parent);

      createdDirs.push(...created.reverse());
    };

    try {
      mkdir(dstDir);

      for (let t = 0; t < entries.length; ++t) {
        const [relativePath, entry] = entries[t];
        const dstPath = path.join(dstDir, relativePath);

        if (entry.kind === `directory`) {
          mkdir(dstPath);
        } else if (entry.kind === `file`) {
          fs.linkSync(contentPaths[t]!, dstPath);
          createdFiles.push(dstPath);

          // Files have rw-r--r-- permissions by default
          const mode = entry.mode & 0o777;
          if (mode !== 0o644) {
            fs.chmodSync(dstPath, mode);
          }
        } else {
          const dstDirname = path.dirname(dstPath);
          fs.symlinkSync(path.relative(dstDirname, path.resolve(dstDirname, entry.symlinkTo)), dstPath);
          createdFiles.push(dstPath);
        }
      }
    } catch {
      // The store changed under our feet: undo what we did, and let the main thread do it again
      for (const file of createdFiles.reverse()) {
        try {
          fs.rmSync(file, {force: true});
        } catch {}
      }

      // Only empty directories are removed: another package of the same scope may be written at the same time
      for (const dir of createdDirs.reverse()) {
        try {
          fs.rmdirSync(dir);
        } catch {}
      }

      return false;
    }

    return true;
  };

  // Mirrors the end of `copyPromise` in NodeModulesLinker
  const write = (dstDir: string, entries: Array<MaterializerWriteEntry>) => {
    fs.mkdirSync(dstDir, {recursive: true});

    for (const entry of entries) {
      const dstPath = path.join(dstDir, entry.relativePath);

      if (entry.kind === `directory`) {
        fs.mkdirSync(dstPath, {recursive: true});
      } else if (entry.kind === `file`) {
        fs.writeFileSync(dstPath, entry.content);

        // Files have rw-r--r-- permissions by default
        const mode = entry.mode & 0o777;
        if (mode !== 0o644) {
          fs.chmodSync(dstPath, mode);
        }
      } else {
        const dstDirname = path.dirname(dstPath);
        fs.symlinkSync(path.relative(dstDirname, path.resolve(dstDirname, entry.symlinkTo)), dstPath);
      }
    }
  };

  // Mirrors `cloneModule` in NodeModulesLinker
  const clone = (srcDir: string, dstDir: string, link: boolean, innerLoop: boolean) => {
    if (!innerLoop)
      fs.mkdirSync(dstDir, {recursive: true});

    for (const entry of fs.readdirSync(srcDir, {withFileTypes: true})) {
      if (!innerLoop && entry.name === `.bin`)
        continue;

      const src = path.join(srcDir, entry.name);
      const dst = path.join(dstDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== `node_modules` || innerLoop) {
          fs.mkdirSync(dst, {recursive: true});
          clone(src, dst, link, true);
        }
      } else if (link) {
        fs.linkSync(src, dst);
      } else {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
      }
    }
  };

  // Mirrors `removeDir` in NodeModulesLinker
  const remove = (dir: string, {contentsOnly, innerLoop, isWorkspaceDir}: {contentsOnly: boolean, innerLoop: boolean, isWorkspaceDir: boolean}) => {
    try {
      let dirStats;
      if (!innerLoop) {
        dirStats = fs.lstatSync(dir);
        if ((!dirStats.isDirectory() && !dirStats.isSymbolicLink()) || (dirStats.isSymbolicLink() && !isWorkspaceDir)) {
          fs.unlinkSync(dir);
          return;
        }
      }

      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const targetPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== `node_modules` || innerLoop) {
            remove(targetPath, {innerLoop: true, contentsOnly: false, isWorkspaceDir: false});
          }
        } else {
          fs.unlinkSync(targetPath);
        }
      }

      const isExternalWorkspaceSymlink = !innerLoop && isWorkspaceDir && dirStats?.isSymbolicLink();
      if (!contentsOnly && !isExternalWorkspaceSymlink) {
        fs.rmdirSync(dir);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== `ENOENT` && code !== `ENOTEMPTY`) {
        throw error;
      }
    }
  };

  parentPort.on(`message`, (request: MaterializerRequest) => {
    let response: MaterializerResponse;
    try {
      if (request.kind === `store`) {
        response = {id: request.id, done: linkFromStore(request)};
      } else if (request.kind === `write`) {
        write(request.dstDir, request.entries);
        response = {id: request.id, done: true};
      } else if (request.kind === `clone`) {
        clone(request.srcDir, request.dstDir, request.link, false);
        response = {id: request.id, done: true};
      } else {
        remove(request.dir, {contentsOnly: request.contentsOnly, innerLoop: false, isWorkspaceDir: request.isWorkspaceDir});
        response = {id: request.id, done: true};
      }
    } catch (error) {
      response = {id: request.id, done: false, error: {message: `${(error as Error)?.message ?? error}`, code: (error as NodeJS.ErrnoException)?.code}};
    }

    parentPort.postMessage(response);
  });
}
