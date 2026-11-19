import {Filename, NativePath, PortablePath, npath, ppath, xfs} from '@yarnpkg/fslib';
import {spawn}                                                 from 'child_process';
import crypto                                                  from 'crypto';
import {createInterface}                                       from 'readline';
import {getSystemErrorName}                                    from 'util';

export type CloneDir = (src: NativePath, dst: NativePath) => Promise<void>;
export type DirCloner = ReturnType<typeof startDirCloner>;

// Node has no clonefile(2) binding, so a Perl process (shipped with macOS) calls clonefileat with AT_FDCWD (-2) and CLONE_NOFOLLOW | CLONE_NOOWNERCOPY (3), and only reports success when both paths exist as distinct inodes
const getCloneScript = (syscall: number) => `$| = 1; $/ = "\\0";
while (defined(my $src = <STDIN>) && defined(my $dst = <STDIN>)) {
  chomp $src; chomp $dst;
  my $ok = syscall(${syscall}, -2, $src, -2, $dst, 3) == 0; my $errno = $! + 0;
  my @s = lstat $src; my @d = lstat $dst;
  print $ok ? (@s && @d && $s[1] != $d[1] ? 0 : -1) : ($errno || -1), "\\n";
}`;

// 462 is clonefileat in xnu's bsd/kern/syscalls.master
export function startDirCloner({perl = `/usr/bin/perl` as NativePath, syscall = 462} = {}) {
  const child = spawn(perl, [`-e`, getCloneScript(syscall)], {stdio: [`pipe`, `pipe`, `ignore`]});
  const pending: Array<{src: NativePath, dst: NativePath, resolve: () => void, reject: (error: Error) => void}> = [];
  let failure: Error | null = null;

  const failAll = (error: Error) => {
    failure ??= error;
    for (const request of pending.splice(0)) {
      request.reject(failure);
    }
  };

  child.on(`error`, failAll);
  child.on(`close`, code => failAll(new Error(`The clonefile helper exited (${code})`)));
  child.stdin.on(`error`, () => {});

  createInterface({input: child.stdout}).on(`line`, line => {
    const errno = Number(line);
    const request = pending.shift();
    if (errno === 0) {
      request?.resolve();
    } else if (request) {
      const code = errno > 0 ? getSystemErrorName(-errno) : `EUNKNOWN`;
      request.reject(Object.assign(new Error(`${code}: clonefile '${request.src}' -> '${request.dst}'`), {code}));
    }
  });

  const clone: CloneDir = (src, dst) => failure !== null
    ? Promise.reject(failure)
    : new Promise((resolve, reject) => {
      pending.push({src, dst, resolve, reject});
      child.stdin.write(`${src}\0${dst}\0`);
    });

  return {clone, close: () => child.stdin.end()};
}

export const getDirCloneSlot = (store: PortablePath, packageChecksum: string) =>
  ppath.join(store, `v1` as Filename, packageChecksum.replace(/[^a-zA-Z0-9]/g, `_`) as Filename);

// Installs racing to create a slot each write their own copy; the first rename wins and the others are discarded
export async function ensureDirCloneSlot(slot: PortablePath, populate: (dir: PortablePath) => Promise<void>) {
  if (await xfs.existsPromise(slot))
    return;

  const tmpSlot = `${slot}.${crypto.randomBytes(8).toString(`hex`)}.tmp` as PortablePath;
  try {
    await populate(tmpSlot);
    await xfs.renamePromise(tmpSlot, slot).catch(() => {});
  } finally {
    await xfs.removePromise(tmpSlot);
  }
}

export async function cloneDirInto(clone: CloneDir, slot: PortablePath, dstDir: PortablePath) {
  await xfs.mkdirPromise(ppath.dirname(dstDir), {recursive: true});

  try {
    await clone(npath.fromPortablePath(slot), npath.fromPortablePath(dstDir));
    return;
  } catch (error) {
    if (error.code !== `EEXIST`) {
      throw error;
    }
  }

  // Nested dependencies created the location first; the slot's own node_modules folder is always empty
  for (const entry of await xfs.readdirPromise(slot)) {
    const dst = ppath.join(dstDir, entry);
    await (entry === `node_modules`
      ? xfs.mkdirPromise(dst, {recursive: true})
      : clone(npath.fromPortablePath(ppath.join(slot, entry)), npath.fromPortablePath(dst)));
  }
}
