import {Hooks, Plugin}       from '@yarnpkg/core';

import {TarballHttpFetcher}  from './TarballHttpFetcher';
import {TarballHttpResolver} from './TarballHttpResolver';
import {isTgzUrl}            from './urlUtils';

export {TarballHttpFetcher};
export {TarballHttpResolver};

const plugin: Plugin<Hooks> = {
  hooks: {
    // Tarballs are only immutable if the lockfile (already part of the key) pins their content
    getUpToDateKeyPart: async (project, locator) => {
      if (!isTgzUrl(locator.reference))
        return undefined;

      return project.storedChecksums.has(locator.locatorHash) ? `` : null;
    },
  },
  fetchers: [
    TarballHttpFetcher,
  ],
  resolvers: [
    TarballHttpResolver,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
