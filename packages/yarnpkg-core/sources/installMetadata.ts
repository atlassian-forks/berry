import {createHash, randomUUID}         from 'crypto';
import {open, readFile, rename, unlink} from 'fs/promises';
import v8                               from 'v8';

type MetadataEntry<T> = {
  installStateChecksum: string;
  state: T;
};

const digestSize = 32;
const digest = (data: Buffer) => createHash(`sha256`).update(data).digest();

export function makeMetadataCache<T>(statePath: string, compressedState: Buffer, stateVersion: number) {
  const path = `${statePath}.metadata`;
  const signature = Buffer.from(`Yarn install metadata/1/${stateVersion}/${process.versions.v8}\0`);
  let sourceDigest: Buffer | undefined;
  const getSourceDigest = () => sourceDigest ??= digest(compressedState);

  return {
    async read(): Promise<MetadataEntry<T> | undefined> {
      try {
        const data = await readFile(path);
        const sourceOffset = signature.length;
        const digestOffset = sourceOffset + digestSize;
        const payloadOffset = digestOffset + digestSize;

        if (data.length <= payloadOffset || !data.subarray(0, sourceOffset).equals(signature))
          return undefined;
        if (!data.subarray(sourceOffset, digestOffset).equals(getSourceDigest()))
          return undefined;

        const payload = data.subarray(payloadOffset);
        if (!data.subarray(digestOffset, payloadOffset).equals(digest(payload)))
          return undefined;

        const entry = v8.deserialize(payload);
        if (typeof entry?.installStateChecksum !== `string` || !/^[a-f0-9]{128}$/.test(entry.installStateChecksum))
          return undefined;
        if (!entry.state || typeof entry.state !== `object`)
          return undefined;

        return entry;
      } catch {
        return undefined;
      }
    },

    async write(entry: MetadataEntry<T>): Promise<void> {
      const temporaryPath = `${path}.${randomUUID()}`;
      let created = false;
      try {
        const payload = v8.serialize(entry);
        const data = Buffer.concat([signature, getSourceDigest(), digest(payload), payload]);
        const handle = await open(temporaryPath, `wx`, 0o600);
        created = true;
        try {
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }

        await rename(temporaryPath, path);
        created = false;
      } catch {
        // A read-only checkout can always use the full install state.
      } finally {
        if (created) {
          await unlink(temporaryPath).catch(() => {});
        }
      }
    },
  };
}
