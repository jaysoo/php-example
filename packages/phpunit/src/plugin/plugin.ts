import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, parse, relative, resolve } from 'node:path';

import {
  CreateNodesContext,
  createNodesFromFiles,
  CreateNodesV2,
  joinPathFragments,
  normalizePath,
  ProjectConfiguration,
  readJsonFile,
  TargetConfiguration,
  writeJsonFile,
} from '@nx/devkit';
import { getNamedInputs } from '@nx/devkit/src/utils/get-named-inputs';
import { calculateHashForCreateNodes } from '@nx/devkit/src/utils/calculate-hash-for-create-nodes';

import { getFilesInDirectoryUsingContext } from 'nx/src/utils/workspace-context';
import { minimatch } from 'minimatch';
import { workspaceDataDirectory } from 'nx/src/utils/cache-directory';
import { hashObject } from 'nx/src/hasher/file-hasher';
import { XMLParser} from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false });

export interface PhpUnitPluginOptions {
  targetName?: string;
  ciTargetName?: string;
}

interface NormalizedOptions {
  targetName: string;
  ciTargetName?: string;
}

type PhpUnitTargets = Pick<ProjectConfiguration, 'targets' | 'metadata'>;

interface PhpUnitTestSuite {
  '@_name': string;
  directory: string;
}

interface PhpUnitConfiguration {
  '@_cacheResultFile'?: string;
  phpunit: {
    testsuites: {
      testsuite: PhpUnitTestSuite;
    }
  };
  coverage: {
    '@_cacheDirectory'?: string;
  };
}

function readTargetsCache(
  cachePath: string
): Record<string, PhpUnitTargets> {
  return existsSync(cachePath) ? readJsonFile(cachePath) : {};
}

function writeTargetsToCache(
  cachePath: string,
  results: Record<string, PhpUnitTargets>
) {
  writeJsonFile(cachePath, results);
}

const phpUnitConfigGlob = '**/phpunit.xml';
export const createNodesV2: CreateNodesV2<PhpUnitPluginOptions> = [
  phpUnitConfigGlob,
  async (configFilePaths, options, context) => {
    const optionsHash = hashObject(options ?? {});
    const cachePath = join(
      workspaceDataDirectory,
      `phpUnit-${optionsHash}.hash`
    );
    const targetsCache = readTargetsCache(cachePath);
    try {
      return await createNodesFromFiles(
        (configFile, options, context) =>
          createNodesInternal(configFile, options ?? {}, context, targetsCache),
        configFilePaths,
        options,
        context
      );
    } finally {
      writeTargetsToCache(cachePath, targetsCache);
    }
  },
];

async function createNodesInternal(
  configFilePath: string,
  options: PhpUnitPluginOptions,
  context: CreateNodesContext,
  targetsCache: Record<string, PhpUnitTargets>
) {
  const projectRoot = dirname(configFilePath);

  // Do not create a project if package.json and project.json isn't there.
  const siblingFiles = readdirSync(join(context.workspaceRoot, projectRoot));
  if (!siblingFiles.includes('composer.json')) {
    return {};
  }

  const normalizedOptions = normalizeOptions(options);
  const composerJson = JSON.parse(readFileSync(join(context.workspaceRoot, projectRoot, 'composer.json')).toString());
  const hash = await calculateHashForCreateNodes(
    projectRoot,
    normalizedOptions,
    context,
    ['composer.json']
  );

  targetsCache[hash] ??= await buildPhpUnitTargets(
    configFilePath,
    projectRoot,
    normalizedOptions,
    context
  );
  const { targets, metadata } = targetsCache[hash];

  return {
    projects: {
      [projectRoot]: {
        name: composerJson.name,
        root: projectRoot,
        targets,
        metadata,
      },
    },
  };
}

async function buildPhpUnitTargets(
  configFilePath: string,
  projectRoot: string,
  options: NormalizedOptions,
  context: CreateNodesContext
): Promise<PhpUnitTargets> {
  const configFileContent = readFileSync(
    join(context.workspaceRoot, configFilePath)
  ).toString();
  const phpUnitConfig = parser.parse(configFileContent) as PhpUnitConfiguration ;

  const namedInputs = getNamedInputs(projectRoot, context);

  const targets: ProjectConfiguration['targets'] = {};
  let metadata: ProjectConfiguration['metadata'];

  const testOutput = getTestOutput(phpUnitConfig);
  const coverageOutput = getCoverageOutput(phpUnitConfig);
  const baseTargetConfig: TargetConfiguration = {
    command: './vendor/bin/phpunit',
    options: {
      cwd: '{projectRoot}',
    },
    parallelism: false,
    metadata: {
      technologies: ['php'],
      description: 'Runs PHPUnit Tests',
      help: {
        command: `./vendor/bin/phpunit --help`,
        example: {
          args: ['--colors']
        },
      },
    },
  };

  targets[options.targetName] = {
    ...baseTargetConfig,
    cache: true,
    inputs: [
      ...('production' in namedInputs
        ? ['default', '^production']
        : ['default', '^default']),
    ],
    outputs: getTargetOutputs(
      testOutput,
      coverageOutput,
      context.workspaceRoot,
      projectRoot
    ),
  };

  if (options.ciTargetName) {
    const ciBaseTargetConfig: TargetConfiguration = {
      ...baseTargetConfig,
      cache: true,
      inputs: [
        ...('production' in namedInputs
          ? ['default', '^production']
          : ['default', '^default']),
      ],
      outputs: getTargetOutputs(
        testOutput,
        coverageOutput,
        context.workspaceRoot,
        projectRoot
      ),
    };

    const groupName = 'Test (CI)';
    metadata = { targetGroups: { [groupName]: [] } };
    const ciTargetGroup = metadata.targetGroups?.[groupName];

    const testDir = phpUnitConfig.phpunit.testsuites.testsuite.directory
      ? joinPathFragments(projectRoot, phpUnitConfig.phpunit.testsuites.testsuite.directory)
      : projectRoot;

    const dependsOn: TargetConfiguration['dependsOn'] = [];

    await forEachTestFile(
      (testFile) => {
        const outputSubfolder = relative(projectRoot, testFile)
          .replace(/[\/\\]/g, '-')
          .replace(/\./g, '-');
        const relativeSpecFilePath = normalizePath(
          relative(projectRoot, testFile)
        );
        const targetName = `${options.ciTargetName}--${relativeSpecFilePath}`;
        ciTargetGroup!.push(targetName);
        targets[targetName] = {
          ...ciBaseTargetConfig,
          options: {
            ...ciBaseTargetConfig.options,
          },
          outputs: getTargetOutputs(
            testOutput,
            coverageOutput,
            context.workspaceRoot,
            projectRoot,
            outputSubfolder
          ),
          command: `${baseTargetConfig.command} ${relativeSpecFilePath}`,
          metadata: {
            technologies: ['php'],
            description: `Runs PHPUnit Tests in ${relativeSpecFilePath} in CI`,
            help: {
              command: `./vendor/bin/phpunit --help`,
              example: {
                args: ['--colors']
              },
            },
          },
        };
        dependsOn.push({
          target: targetName,
          projects: 'self',
          params: 'forward',
        });
      },
      {
        context,
        path: testDir,
        config: phpUnitConfig,
      }
    );

    targets[options.ciTargetName] ??= {};

    targets[options.ciTargetName] = {
      executor: 'nx:noop',
      cache: ciBaseTargetConfig.cache,
      inputs: ciBaseTargetConfig.inputs,
      outputs: ciBaseTargetConfig.outputs,
      dependsOn,
      parallelism: false,
      metadata: {
        technologies: ['php'],
        description: 'Runs PHPUnit Tests in CI',
        nonAtomizedTarget: options.targetName,
        help: {
          command: `./vendor/bin/phpunit --help`,
          example: {
            args: ['--colors']
          },
        },
      },
    };
    ciTargetGroup!.push(options.ciTargetName);
  }

  return { targets, metadata };
}

async function forEachTestFile(
  cb: (path: string) => void,
  opts: {
    context: CreateNodesContext;
    path: string;
    config: PhpUnitConfiguration;
  }
) {
  const files = await getFilesInDirectoryUsingContext(
    opts.context.workspaceRoot,
    opts.path
  );
  const matcher = createMatcher('**/*Test.php');
  for (const file of files) {
    if (matcher(file)) {
      cb(file);
    }
  }
}

function createMatcher(pattern: string | RegExp | Array<string | RegExp>): (a: string) => boolean {
  if (Array.isArray(pattern)) {
    const matchers = pattern.map((p) => createMatcher(p));
    return (path: string) => matchers.some((m) => m(path));
  } else if (pattern instanceof RegExp) {
    return (path: string) => pattern.test(path);
  } else {
    return (path: string) => {
      try {
        return minimatch(path, pattern);
      } catch (e) {
        if (e instanceof Error) {
          throw new Error(`Error matching ${path} with ${pattern}: ${e.message}`);
        } else {
          throw new Error(`Error matching ${path} with ${pattern}: ${e}`);
        }
      }
    };
  }
}

function normalizeOptions(options: PhpUnitPluginOptions): NormalizedOptions {
  return {
    ...options,
    targetName: options?.targetName ?? 'test',
    ciTargetName: options?.ciTargetName ?? 'test-ci',
  };
}

function getTestOutput(phpUnitConfig: PhpUnitConfiguration): string {
  if (phpUnitConfig['@_cacheResultFile']) {
    return phpUnitConfig['@_cacheResultFile'];
  } else {
    return '.phpunit.cache/test-results';
  }
}

function getCoverageOutput(
  phpUnitConfig: PhpUnitConfiguration
): string | undefined {
  return phpUnitConfig.coverage?.['@_cacheDirectory']
}

function getTargetOutputs(
  testOutput: string,
  coverageOutput: string | undefined,
  workspaceRoot: string,
  projectRoot: string,
  subFolder?: string
): string[] {
  const outputs = new Set<string>();
  outputs.add(
    normalizeOutput(
      addSubfolderToOutput(testOutput, subFolder),
      workspaceRoot,
      projectRoot
    )
  );
  if (coverageOutput) {
    outputs.add(
      normalizeOutput(
        addSubfolderToOutput(coverageOutput, subFolder),
        workspaceRoot,
        projectRoot
      )
    );
  }
  return Array.from(outputs);
}

function addSubfolderToOutput(output: string, subfolder?: string): string {
  if (!subfolder) return output;
  const parts = parse(output);
  if (parts.ext !== '') {
    return join(parts.dir, subfolder, parts.base);
  }
  return join(output, subfolder);
}

function normalizeOutput(
  path: string,
  workspaceRoot: string,
  projectRoot: string
): string {
  const fullProjectRoot = resolve(workspaceRoot, projectRoot);
  const fullPath = resolve(fullProjectRoot, path);
  const pathRelativeToProjectRoot = normalizePath(
    relative(fullProjectRoot, fullPath)
  );
  if (pathRelativeToProjectRoot.startsWith('..')) {
    return joinPathFragments(
      '{workspaceRoot}',
      relative(workspaceRoot, fullPath)
    );
  }
  return joinPathFragments('{projectRoot}', pathRelativeToProjectRoot);
}
