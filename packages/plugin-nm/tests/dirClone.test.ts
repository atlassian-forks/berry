import {Filename, PortablePath, npath, ppath, xfs}  from '@yarnpkg/fslib';

import {CloneDir, cloneDirInto, ensureDirCloneSlot} from '../sources/dirClone';
import {startDirCloner}                             from '../sources/dirClone';

// Behaves like clonefile(2): copies the whole tree and refuses to overwrite
const fakeClone: CloneDir = async (src, dst) => {
  if (await xfs.existsPromise(npath.toPortablePath(dst)))
    throw Object.assign(new Error(`EEXIST`), {code: `EEXIST`});

  await xfs.copyPromise(npath.toPortablePath(dst), npath.toPortablePath(src));
};

const writePackage = async (dir: PortablePath) => {
  await xfs.mkdirPromise(ppath.join(dir, `lib` as Filename), {recursive: true});
  await xfs.writeFilePromise(ppath.join(dir, `lib/index.js` as PortablePath), `module.exports = 42;\n`);
  await xfs.symlinkPromise(`lib/index.js` as PortablePath, ppath.join(dir, `main.js` as Filename));
};

const describeOnMacOS = process.platform === `darwin` ? describe : describe.skip;

describeOnMacOS(`startDirCloner`, () => {
  it(`should clone whole directories, keep symlinks and report existing destinations`, async () => {
    await xfs.mktempPromise(async tmp => {
      const src = ppath.join(tmp, `slot` as Filename);
      const dst = ppath.join(tmp, `node_modules/pkg` as PortablePath);
      await writePackage(src);
      await xfs.mkdirPromise(ppath.dirname(dst));

      const cloner = startDirCloner();
      await cloner.clone(npath.fromPortablePath(src), npath.fromPortablePath(dst));
      await expect(cloner.clone(npath.fromPortablePath(src), npath.fromPortablePath(dst))).rejects.toMatchObject({code: `EEXIST`});
      cloner.close();

      expect(await xfs.readFilePromise(ppath.join(dst, `lib/index.js` as PortablePath), `utf8`)).toEqual(`module.exports = 42;\n`);
      expect(await xfs.readlinkPromise(ppath.join(dst, `main.js` as Filename))).toEqual(`lib/index.js`);
    });
  });

  it(`should reject clones from a syscall that succeeds without cloning`, async () => {
    await xfs.mktempPromise(async tmp => {
      // 36 is sync, which returns 0 and creates nothing
      const cloner = startDirCloner({syscall: 36});
      await expect(cloner.clone(npath.fromPortablePath(tmp), npath.fromPortablePath(ppath.join(tmp, `dst` as Filename)))).rejects.toMatchObject({code: `EUNKNOWN`});
      cloner.close();
    });
  });

  it(`should reject clones when Perl is missing`, async () => {
    const cloner = startDirCloner({perl: npath.fromPortablePath(`/missing/perl` as PortablePath)});
    await expect(cloner.clone(`/src`, `/dst`)).rejects.toThrow();
  });
});

describe(`ensureDirCloneSlot`, () => {
  it(`should populate a slot once and keep the first copy when installs race`, async () => {
    await xfs.mktempPromise(async tmp => {
      const slot = ppath.join(tmp, `v1/checksum` as PortablePath);
      const populate = jest.fn(async (tmpSlot: PortablePath) => {
        await writePackage(slot);
        await xfs.mkdirPromise(tmpSlot, {recursive: true});
        await xfs.writeFilePromise(ppath.join(tmpSlot, `loser` as Filename), ``);
      });

      await ensureDirCloneSlot(slot, populate);
      await ensureDirCloneSlot(slot, populate);

      expect(populate).toHaveBeenCalledTimes(1);
      expect(await xfs.existsPromise(ppath.join(slot, `loser` as Filename))).toEqual(false);
      expect(await xfs.readdirPromise(ppath.dirname(slot))).toEqual([`checksum`]);
    });
  });

  it(`should not leave a partial slot behind when populating fails`, async () => {
    await xfs.mktempPromise(async tmp => {
      const slot = ppath.join(tmp, `checksum` as Filename);

      await expect(ensureDirCloneSlot(slot, async tmpSlot => {
        await writePackage(tmpSlot);
        throw new Error(`Extraction failed`);
      })).rejects.toThrow(`Extraction failed`);

      expect(await xfs.readdirPromise(tmp)).toEqual([]);
    });
  });
});

describe(`cloneDirInto`, () => {
  it(`should merge into a location that nested dependencies created first`, async () => {
    await xfs.mktempPromise(async tmp => {
      const slot = ppath.join(tmp, `slot` as Filename);
      const dstDir = ppath.join(tmp, `node_modules/pkg` as PortablePath);
      await writePackage(slot);
      await xfs.mkdirPromise(ppath.join(slot, `node_modules` as Filename));
      await xfs.mkdirPromise(ppath.join(dstDir, `node_modules/dep` as PortablePath), {recursive: true});

      await cloneDirInto(fakeClone, slot, dstDir);

      expect((await xfs.readdirPromise(dstDir)).sort()).toEqual([`lib`, `main.js`, `node_modules`]);
      expect(await xfs.readdirPromise(ppath.join(dstDir, `node_modules` as Filename))).toEqual([`dep`]);
    });
  });
});
