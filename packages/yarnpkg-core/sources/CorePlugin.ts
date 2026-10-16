import {Resolution}               from '@yarnpkg/parsers';

import {MessageName}              from './MessageName';
import {Plugin}                   from './Plugin';
import {Project}                  from './Project';
import {Resolver, ResolveOptions} from './Resolver';
import {Workspace}                from './Workspace';
import * as structUtils           from './structUtils';
import {Descriptor, Locator}      from './types';

// Index resolutions by `descriptor.fullName` so `reduceDependency` can look up
// candidates instead of scanning the whole `resolutions` array per dependency.
// Buckets keep insertion order (first match wins).
//
// The `resolutions` array is mutable: plugins (e.g. focus-style commands) may
// push entries into it in place between two installs on the same Project. The
// index is therefore dropped at the start of every resolution pass (see
// `invalidateResolutionsIndex`), and rebuilt if the array length changes.
type ResolutionEntry = {pattern: Resolution, reference: string};
type ResolutionsIndex = {length: number, index: Map<string, Array<ResolutionEntry>>};

const resolutionsIndexCache = new WeakMap<Array<ResolutionEntry>, ResolutionsIndex>();

export const invalidateResolutionsIndex = (resolutions: Array<ResolutionEntry>) => {
  resolutionsIndexCache.delete(resolutions);
};

const getResolutionsIndex = (resolutions: Array<ResolutionEntry>): Map<string, Array<ResolutionEntry>> => {
  const cached = resolutionsIndexCache.get(resolutions);
  if (typeof cached !== `undefined` && cached.length === resolutions.length)
    return cached.index;

  const index = new Map<string, Array<ResolutionEntry>>();
  for (const entry of resolutions) {
    let bucket = index.get(entry.pattern.descriptor.fullName);
    if (typeof bucket === `undefined`)
      index.set(entry.pattern.descriptor.fullName, bucket = []);

    bucket.push(entry);
  }

  resolutionsIndexCache.set(resolutions, {length: resolutions.length, index});
  return index;
};

export const CorePlugin: Plugin = {
  hooks: {
    reduceDependency: (dependency: Descriptor, project: Project, locator: Locator, initialDependency: Descriptor, {resolver, resolveOptions}: {resolver: Resolver, resolveOptions: ResolveOptions}) => {
      const resolutions = project.topLevelWorkspace.manifest.resolutions;

      const candidates = getResolutionsIndex(resolutions).get(structUtils.stringifyIdent(dependency));
      if (typeof candidates === `undefined`)
        return dependency;

      for (const {pattern, reference} of candidates) {
        if (pattern.from) {
          if (pattern.from.fullName !== structUtils.stringifyIdent(locator))
            continue;

          const normalizedFrom = project.configuration.normalizeLocator(
            structUtils.makeLocator(
              structUtils.parseIdent(pattern.from.fullName),
              pattern.from.description ?? locator.reference,
            ),
          );

          if (normalizedFrom.locatorHash !== locator.locatorHash) {
            continue;
          }
        }

        /* All `resolutions` field entries have a descriptor*/ {
          const normalizedDescriptor = project.configuration.normalizeDependency(
            structUtils.makeDescriptor(
              structUtils.parseLocator(pattern.descriptor.fullName),
              pattern.descriptor.description ?? dependency.range,
            ),
          );

          if (normalizedDescriptor.descriptorHash !== dependency.descriptorHash) {
            continue;
          }
        }

        const alias = resolver.bindDescriptor(
          project.configuration.normalizeDependency(structUtils.makeDescriptor(dependency, reference)),
          project.topLevelWorkspace.anchoredLocator,
          resolveOptions,
        );

        return alias;
      }

      return dependency;
    },

    validateProject: async (project: Project, report: {
      reportWarning: (name: MessageName, text: string) => void;
      reportError: (name: MessageName, text: string) => void;
    }) => {
      for (const workspace of project.workspaces) {
        const workspaceName = structUtils.prettyWorkspace(project.configuration, workspace);

        await project.configuration.triggerHook(hooks => {
          return hooks.validateWorkspace;
        }, workspace, {
          reportWarning: (name: MessageName, text: string) => report.reportWarning(name, `${workspaceName}: ${text}`),
          reportError: (name: MessageName, text: string) => report.reportError(name, `${workspaceName}: ${text}`),
        });
      }
    },

    validateWorkspace: async (workspace: Workspace, report: {
      reportWarning: (name: MessageName, text: string) => void;
      reportError: (name: MessageName, text: string) => void;
    }) => {
      // Validate manifest
      const {manifest} = workspace;

      if (manifest.resolutions.length && workspace.cwd !== workspace.project.cwd)
        manifest.errors.push(new Error(`Resolutions field will be ignored`));

      for (const manifestError of manifest.errors) {
        report.reportWarning(MessageName.INVALID_MANIFEST, manifestError.message);
      }
    },
  },
};
