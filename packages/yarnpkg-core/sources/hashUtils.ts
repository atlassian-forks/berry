import {PortablePath, xfs, npath, FakeFS, ppath} from '@yarnpkg/fslib';
import {createHash, BinaryLike, webcrypto}       from 'crypto';
import fastGlob                                  from 'fast-glob';

export function makeHash<T extends string = string>(...args: Array<BinaryLike | null>): T {
  const hash = createHash(`sha512`);

  let acc = ``;
  for (const arg of args) {
    if (typeof arg === `string`) {
      acc += arg;
    } else if (arg) {
      if (acc) {
        hash.update(acc);
        acc = ``;
      }

      hash.update(arg);
    }
  }

  if (acc)
    hash.update(acc);

  return hash.digest(`hex`) as T;
}

// Files up to a moderate size are read in one go, which (for archive entries) decompresses them once rather than once
// per chunk. The larger ones among them are hashed with WebCrypto, which runs on the libuv threadpool, so that they're
// hashed in parallel rather than one after the other on the main thread; for small files the round-trip costs more
const SINGLE_READ_MAX_FILE_SIZE = 16 * 1024 * 1024;
const WEBCRYPTO_MIN_FILE_SIZE = 512 * 1024;
const WEBCRYPTO_ALGORITHMS = new Map([[`sha1`, `SHA-1`], [`sha256`, `SHA-256`], [`sha512`, `SHA-512`]]);

export async function checksumFile(path: PortablePath, {baseFs, algorithm}: {baseFs: FakeFS<PortablePath>, algorithm: string} = {baseFs: xfs, algorithm: `sha512`}) {
  const fd = await baseFs.openPromise(path, `r`);

  try {
    const {size} = await baseFs.fstatPromise(fd);
    if (size <= SINGLE_READ_MAX_FILE_SIZE) {
      // One extra byte, to notice files that grew since we checked their size; anything unexpected (including short
      // reads) falls back to reading the file in chunks
      const content = Buffer.allocUnsafe(size + 1);
      const bytesRead = await baseFs.readPromise(fd, content, 0, size + 1, 0);

      if (bytesRead === size) {
        const webcryptoAlgorithm = WEBCRYPTO_ALGORITHMS.get(algorithm);
        if (typeof webcryptoAlgorithm !== `undefined` && size >= WEBCRYPTO_MIN_FILE_SIZE)
          return Buffer.from(await webcrypto.subtle.digest(webcryptoAlgorithm, content.subarray(0, size))).toString(`hex`);

        return createHash(algorithm).update(content.subarray(0, size)).digest(`hex`);
      }
    }

    const CHUNK_SIZE = 65536;
    const chunk = Buffer.allocUnsafeSlow(CHUNK_SIZE);

    const hash = createHash(algorithm);

    let bytesRead = 0;
    while ((bytesRead = await baseFs.readPromise(fd, chunk, 0, CHUNK_SIZE)) !== 0)
      hash.update(bytesRead === CHUNK_SIZE ? chunk : chunk.slice(0, bytesRead));

    return hash.digest(`hex`);
  } finally {
    await baseFs.closePromise(fd);
  }
}

export async function checksumPattern(pattern: string, {cwd}: {cwd: PortablePath}) {
  // Note: We use a two-pass glob instead of using globby with the expandDirectories
  // option, because the native implementation is broken.
  //
  // Ref: https://github.com/sindresorhus/globby/issues/147

  const dirListing = await fastGlob(pattern, {
    cwd: npath.fromPortablePath(cwd),
    onlyDirectories: true,
  });

  const dirPatterns = dirListing.map(entry => {
    return `${entry}/**/*`;
  });

  const listing = await fastGlob([pattern, ...dirPatterns], {
    cwd: npath.fromPortablePath(cwd),
    onlyFiles: false,
  });

  // fast-glob returns results in arbitrary order
  listing.sort();

  const hashes = await Promise.all(listing.map(async entry => {
    const parts: Array<Buffer> = [Buffer.from(entry)];

    const p = ppath.join(cwd, npath.toPortablePath(entry));
    const stat = await xfs.lstatPromise(p);

    if (stat.isSymbolicLink())
      parts.push(Buffer.from(await xfs.readlinkPromise(p)));
    else if (stat.isFile())
      parts.push(await xfs.readFilePromise(p));

    return parts.join(`\u0000`);
  }));

  const hash = createHash(`sha512`);
  for (const sub of hashes)
    hash.update(sub);

  return hash.digest(`hex`);
}
