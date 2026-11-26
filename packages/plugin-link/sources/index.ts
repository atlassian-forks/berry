import {Hooks, Plugin, structUtils} from '@yarnpkg/core';
import {Filename, ppath, xfs}       from '@yarnpkg/fslib';

import {LinkFetcher}                from './LinkFetcher';
import {LinkResolver}               from './LinkResolver';
import {PortalFetcher}              from './PortalFetcher';
import {PortalResolver}             from './PortalResolver';
import {LINK_PROTOCOL}              from './constants';

export {PortalFetcher};
export {PortalResolver};
export {LinkFetcher};
export {LinkResolver};

const plugin: Plugin<Hooks> = {
  hooks: {
    // Linked folders are used as they are: installs only read their manifest (for their binaries)
    getUpToDateKeyPart: async (project, locator) => {
      if (!locator.reference.startsWith(LINK_PROTOCOL))
        return undefined;

      const {parentLocator, path} = structUtils.parseFileStyleRange(locator.reference, {protocol: LINK_PROTOCOL});

      // Relative paths are resolved from the package that declared the link, which we can only read here if it's a workspace
      let target = path;
      if (!ppath.isAbsolute(path)) {
        const parentWorkspace = project.tryWorkspaceByLocator(parentLocator);
        if (parentWorkspace === null)
          return null;

        target = ppath.resolve(parentWorkspace.cwd, path);
      }

      const manifest = await xfs.readFilePromise(ppath.join(target, Filename.manifest), `utf8`).catch(() => `<missing>`);
      return [structUtils.stringifyLocator(locator), target, manifest].join(`\0`);
    },
  },
  fetchers: [
    LinkFetcher,
    PortalFetcher,
  ],
  resolvers: [
    LinkResolver,
    PortalResolver,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
