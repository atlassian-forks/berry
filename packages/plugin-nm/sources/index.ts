import {Hooks, Plugin, SettingsType}        from '@yarnpkg/core';
import {xfs}                                from '@yarnpkg/fslib';
import {NodeModulesHoistingLimits}          from '@yarnpkg/nm';

import {NodeModulesLinker, NodeModulesMode} from './NodeModulesLinker';
import {getDirCloneStore}                   from './NodeModulesLinker';
import {getGlobalHardlinksStore}            from './NodeModulesLinker';
import {isNodeModulesUpToDate}              from './NodeModulesLinker';
import {PnpLooseLinker}                     from './PnpLooseLinker';

export {NodeModulesLinker};
export {NodeModulesMode};
export {PnpLooseLinker};

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    nmDirClone: boolean;
    nmHoistingLimits: NodeModulesHoistingLimits;
    nmMode: NodeModulesMode;
    nmSelfReferences: boolean;
  }
}

const plugin: Plugin<Hooks> = {
  hooks: {
    cleanGlobalArtifacts: async configuration => {
      const globalHardlinksDirectory = getGlobalHardlinksStore(configuration);
      await xfs.removePromise(globalHardlinksDirectory);
      await xfs.removePromise(getDirCloneStore(configuration));
    },
    isInstallUpToDate: async (upToDate, project) => {
      if (upToDate === false || project.configuration.get(`nodeLinker`) !== `node-modules`)
        return upToDate;

      return await isNodeModulesUpToDate(project);
    },
  },
  configuration: {
    nmDirClone: {
      description: `On macOS, extract each package once into the global folder and clone it into \`node_modules\` as a whole directory with \`clonefile(2)\`, instead of writing it file by file. Applies to the \`classic\` and \`hardlinks-local\` modes, and falls back to copying when the volume cannot clone.`,
      type: SettingsType.BOOLEAN,
      default: true,
    },
    nmHoistingLimits: {
      description: `Prevents packages to be hoisted past specific levels`,
      type: SettingsType.STRING,
      values: [
        NodeModulesHoistingLimits.WORKSPACES,
        NodeModulesHoistingLimits.DEPENDENCIES,
        NodeModulesHoistingLimits.NONE,
      ],
      default: NodeModulesHoistingLimits.NONE,
    },
    nmMode: {
      description: `Defines in which measure Yarn must use hardlinks and symlinks when generated \`node_modules\` directories.`,
      type: SettingsType.STRING,
      values: [
        NodeModulesMode.CLASSIC,
        NodeModulesMode.HARDLINKS_LOCAL,
        NodeModulesMode.HARDLINKS_GLOBAL,
      ],
      default: NodeModulesMode.CLASSIC,
    },
    nmSelfReferences: {
      description: `Defines whether the linker should generate self-referencing symlinks for workspaces.`,
      type: SettingsType.BOOLEAN,
      default: true,
    },
  },
  linkers: [
    NodeModulesLinker,
    PnpLooseLinker,
  ],
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
