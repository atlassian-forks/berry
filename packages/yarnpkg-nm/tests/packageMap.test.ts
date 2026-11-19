import {PortablePath}              from '@yarnpkg/fslib';
import {PnpApi}                    from '@yarnpkg/pnp';

import {LinkType, NodeModulesTree} from '../sources/buildNodeModulesTree';
import {buildPackageMap}           from '../sources';

describe(`buildPackageMap`, () => {
  it(`should generate one package map entry for each node_modules package node`, () => {
    const tree: NodeModulesTree = new Map([
      [`/project` as PortablePath, {
        locator: `root@workspace:.`,
        target: `/project` as PortablePath,
        linkType: LinkType.SOFT,
        nodePath: ``,
        aliases: [],
      }],
      [`/project/node_modules/foo` as PortablePath, {
        locator: `foo@npm:1.0.0`,
        target: `/cache/foo` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/foo`,
        aliases: [],
      }],
      [`/project/node_modules/bar` as PortablePath, {
        locator: `bar@npm:1.0.0`,
        target: `/cache/bar` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/bar`,
        aliases: [],
      }],
      [`/project/node_modules/foo/node_modules/baz` as PortablePath, {
        locator: `baz@npm:1.0.0`,
        target: `/cache/baz` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/foo/baz`,
        aliases: [],
      }],
      [`/project/packages/workspace/node_modules/foo` as PortablePath, {
        locator: `foo@npm:1.0.0`,
        target: `/cache/foo` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/workspace/foo`,
        aliases: [],
      }],
    ]);

    const pnp = {
      getPackageInformation: ({name, reference}: {name: string, reference: string}) => {
        const packageDependencies = new Map<string, string | null>();

        if (`${name}@${reference}` === `root@workspace:.`) {
          packageDependencies.set(`bar`, `npm:1.0.0`);
          packageDependencies.set(`foo`, `npm:1.0.0`);
        }

        if (`${name}@${reference}` === `foo@npm:1.0.0`)
          packageDependencies.set(`baz`, `npm:1.0.0`);

        return {packageDependencies};
      },
    } as unknown as PnpApi;

    expect(buildPackageMap(tree, {basePath: `/project/node_modules` as PortablePath, pnp})).toEqual({
      packages: {
        '.': {
          url: `..`,
          dependencies: {
            bar: `bar`,
            foo: `foo`,
          },
        },
        '../packages/workspace/node_modules/foo': {
          url: `../packages/workspace/node_modules/foo`,
          dependencies: {},
        },
        bar: {
          url: `./bar`,
          dependencies: {},
        },
        foo: {
          url: `./foo`,
          dependencies: {
            baz: `foo/node_modules/baz`,
          },
        },
        'foo/node_modules/baz': {
          url: `./foo/node_modules/baz`,
          dependencies: {},
        },
      },
    });
  });

  it(`should resolve each dependency to the nearest node_modules level (shadowing)`, () => {
    // `app` depends on `dep`. There are two `dep` copies: a nested one under
    // app/node_modules (nearer) and a hoisted one at the root (farther).
    // The nearer copy must win. This guards the parent-walk de-dup order.
    const tree: NodeModulesTree = new Map([
      [`/project` as PortablePath, {
        locator: `root@workspace:.`,
        target: `/project` as PortablePath,
        linkType: LinkType.SOFT,
        nodePath: ``,
        aliases: [],
      }],
      [`/project/node_modules/app` as PortablePath, {
        locator: `app@npm:1.0.0`,
        target: `/cache/app` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/app`,
        aliases: [],
      }],
      [`/project/node_modules/dep` as PortablePath, {
        locator: `dep@npm:1.0.0`,
        target: `/cache/dep-root` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/dep`,
        aliases: [],
      }],
      [`/project/node_modules/app/node_modules/dep` as PortablePath, {
        locator: `dep@npm:2.0.0`,
        target: `/cache/dep-nested` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/app/dep`,
        aliases: [],
      }],
    ]);

    const pnp = {
      getPackageInformation: ({name, reference}: {name: string, reference: string}) => {
        const packageDependencies = new Map<string, string | null>();

        if (`${name}@${reference}` === `root@workspace:.`)
          packageDependencies.set(`app`, `npm:1.0.0`);

        if (`${name}@${reference}` === `app@npm:1.0.0`)
          packageDependencies.set(`dep`, `npm:2.0.0`);

        return {packageDependencies};
      },
    } as unknown as PnpApi;

    const result = buildPackageMap(tree, {basePath: `/project/node_modules` as PortablePath, pnp});

    // app's `dep` must point at the nested copy, not the root copy.
    expect(result.packages.app.dependencies).toEqual({
      dep: `app/node_modules/dep`,
    });
  });

  it(`should resolve scoped dependencies by their full scoped name`, () => {
    const tree: NodeModulesTree = new Map([
      [`/project` as PortablePath, {
        locator: `root@workspace:.`,
        target: `/project` as PortablePath,
        linkType: LinkType.SOFT,
        nodePath: ``,
        aliases: [],
      }],
      [`/project/node_modules/@scope/foo` as PortablePath, {
        locator: `@scope/foo@npm:1.0.0`,
        target: `/cache/scope-foo` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/@scope/foo`,
        aliases: [],
      }],
    ]);

    const pnp = {
      getPackageInformation: ({name, reference}: {name: string, reference: string}) => {
        const packageDependencies = new Map<string, string | null>();
        if (`${name}@${reference}` === `root@workspace:.`)
          packageDependencies.set(`@scope/foo`, `npm:1.0.0`);

        return {packageDependencies};
      },
    } as unknown as PnpApi;

    const result = buildPackageMap(tree, {basePath: `/project/node_modules` as PortablePath, pnp});

    expect(result.packages[`.`].dependencies).toEqual({
      '@scope/foo': `@scope/foo`,
    });
  });

  it(`should resolve dependencies across a deep node_modules chain`, () => {
    const tree: NodeModulesTree = new Map([
      [`/project` as PortablePath, {
        locator: `root@workspace:.`,
        target: `/project` as PortablePath,
        linkType: LinkType.SOFT,
        nodePath: ``,
        aliases: [],
      }],
      // `shared` is hoisted to the root; a deeply nested package must still find it
      // by walking parent node_modules levels.
      [`/project/node_modules/shared` as PortablePath, {
        locator: `shared@npm:1.0.0`,
        target: `/cache/shared` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/shared`,
        aliases: [],
      }],
      [`/project/node_modules/a` as PortablePath, {
        locator: `a@npm:1.0.0`,
        target: `/cache/a` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/a`,
        aliases: [],
      }],
      [`/project/node_modules/a/node_modules/b` as PortablePath, {
        locator: `b@npm:1.0.0`,
        target: `/cache/b` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/a/b`,
        aliases: [],
      }],
    ]);

    const pnp = {
      getPackageInformation: ({name, reference}: {name: string, reference: string}) => {
        const packageDependencies = new Map<string, string | null>();
        if (`${name}@${reference}` === `b@npm:1.0.0`)
          packageDependencies.set(`shared`, `npm:1.0.0`);

        return {packageDependencies};
      },
    } as unknown as PnpApi;

    const result = buildPackageMap(tree, {basePath: `/project/node_modules` as PortablePath, pnp});

    // `b` (nested two levels deep) resolves `shared` from the root node_modules.
    expect(result.packages[`a/node_modules/b`].dependencies).toEqual({
      shared: `shared`,
    });
  });

  it(`should omit dependencies that are declared but not present in any node_modules level`, () => {
    const tree: NodeModulesTree = new Map([
      [`/project` as PortablePath, {
        locator: `root@workspace:.`,
        target: `/project` as PortablePath,
        linkType: LinkType.SOFT,
        nodePath: ``,
        aliases: [],
      }],
      [`/project/node_modules/present` as PortablePath, {
        locator: `present@npm:1.0.0`,
        target: `/cache/present` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/present`,
        aliases: [],
      }],
    ]);

    const pnp = {
      getPackageInformation: ({name, reference}: {name: string, reference: string}) => {
        const packageDependencies = new Map<string, string | null>();
        if (`${name}@${reference}` === `root@workspace:.`) {
          packageDependencies.set(`present`, `npm:1.0.0`);
          // `missing` is declared but has no location in the tree; it must be skipped
          // rather than throwing or being emitted.
          packageDependencies.set(`missing`, `npm:1.0.0`);
        }

        return {packageDependencies};
      },
    } as unknown as PnpApi;

    const result = buildPackageMap(tree, {basePath: `/project/node_modules` as PortablePath, pnp});

    expect(result.packages[`.`].dependencies).toEqual({
      present: `present`,
    });
  });

  it(`should generate loose package dependencies from node_modules hoisting`, () => {
    const tree: NodeModulesTree = new Map([
      [`/project` as PortablePath, {
        locator: `root@workspace:.`,
        target: `/project` as PortablePath,
        linkType: LinkType.SOFT,
        nodePath: ``,
        aliases: [],
      }],
      [`/project/node_modules/foo` as PortablePath, {
        locator: `foo@npm:1.0.0`,
        target: `/cache/foo` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/foo`,
        aliases: [],
      }],
      [`/project/node_modules/bar` as PortablePath, {
        locator: `bar@npm:1.0.0`,
        target: `/cache/bar` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/bar`,
        aliases: [],
      }],
      [`/project/node_modules/foo/node_modules/baz` as PortablePath, {
        locator: `baz@npm:1.0.0`,
        target: `/cache/baz` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/foo/baz`,
        aliases: [],
      }],
      [`/project/packages/workspace/node_modules/foo` as PortablePath, {
        locator: `foo@npm:1.0.0`,
        target: `/cache/foo` as PortablePath,
        linkType: LinkType.HARD,
        nodePath: `/workspace/foo`,
        aliases: [],
      }],
    ]);

    expect(buildPackageMap(tree, {basePath: `/project/node_modules` as PortablePath, pnp: null})).toEqual({
      packages: {
        '.': {
          url: `..`,
          dependencies: {
            bar: `bar`,
            foo: `foo`,
          },
        },
        '../packages/workspace/node_modules/foo': {
          url: `../packages/workspace/node_modules/foo`,
          dependencies: {
            bar: `bar`,
            foo: `../packages/workspace/node_modules/foo`,
          },
        },
        bar: {
          url: `./bar`,
          dependencies: {
            bar: `bar`,
            foo: `foo`,
          },
        },
        foo: {
          url: `./foo`,
          dependencies: {
            bar: `bar`,
            baz: `foo/node_modules/baz`,
            foo: `foo`,
          },
        },
        'foo/node_modules/baz': {
          url: `./foo/node_modules/baz`,
          dependencies: {
            bar: `bar`,
            baz: `foo/node_modules/baz`,
            foo: `foo`,
          },
        },
      },
    });
  });
});
