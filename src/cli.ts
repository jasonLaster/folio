/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { default as ignore } from 'fstream-ignore';
import * as commander from 'commander';
import * as fs from 'fs';
import { default as minimatch } from 'minimatch';
import * as path from 'path';
import { Reporter, EmptyReporter } from './reporter';
import DotReporter from './reporters/dot';
import JSONReporter from './reporters/json';
import JUnitReporter from './reporters/junit';
import LineReporter from './reporters/line';
import ListReporter from './reporters/list';
import { Multiplexer } from './reporters/multiplexer';
import { Runner } from './runner';
import { Config, PartialConfig } from './types';
import { Loader } from './loader';

export const reporters = {
  'dot': DotReporter,
  'json': JSONReporter,
  'junit': JUnitReporter,
  'line': LineReporter,
  'list': ListReporter,
  'null': EmptyReporter,
};

const availableReporters = Object.keys(reporters).map(r => `"${r}"`).join();

const defaultConfig: Config = {
  fixtureIgnore: 'node_modules/**',
  fixtureMatch: '**/?(*.)fixtures.[jt]s',
  fixtureOptions: {} as any,
  forbidOnly: false,
  globalTimeout: 0,
  grep: '.*',
  maxFailures: 0,
  outputDir: path.join(process.cwd(), 'test-results'),
  quiet: false,
  repeatEach: 1,
  retries: 0,
  shard: undefined,
  snapshotDir: '__snapshots__',
  testDir: '',
  testIgnore: 'node_modules/**',
  testMatch: '**/?(*.)+(spec|test).[jt]s',
  timeout: 10000,
  updateSnapshots: false,
  workers: Math.ceil(require('os').cpus().length / 2),
};

const loadProgram = new commander.Command();
addRunnerOptions(loadProgram);
loadProgram.action(async command => {
  try {
    await runTests(command);
  } catch (e) {
    console.log(e);
    process.exit(1);
  }
});
loadProgram.parse(process.argv);

async function runTests(command: any) {
  const reporterList = command.reporter.split(',');
  const reporterObjects: Reporter[] = reporterList.map(c => {
    if (reporters[c])
      return new reporters[c]();
    try {
      const p = path.resolve(process.cwd(), c);
      return new (require(p).default)();
    } catch (e) {
      console.error('Invalid reporter ' + c, e);
      process.exit(1);
    }
  });

  const loader = new Loader(defaultConfig);

  if (command.config) {
    const configFile = path.resolve(process.cwd(), command.config);
    if (!fs.existsSync(configFile))
      throw new Error(`${configFile} does not exist`);
    loader.loadConfigFile(configFile);
  }

  if (command.args.length)
    loader.addConfig({ testDir: path.resolve(process.cwd(), command.args[0] || '.') });

  const testDir = loader.config().testDir;
  if (!fs.existsSync(testDir))
    throw new Error(`${testDir} does not exist`);
  if (!fs.statSync(testDir).isDirectory())
    throw new Error(`${testDir} is not a directory`);

  if (!command.config) {
    for (const configFile of [path.join(testDir, 'folio.config.ts'), path.join(testDir, 'folio.config.js')]) {
      if (fs.existsSync(configFile)) {
        loader.loadConfigFile(configFile);
        break;
      }
    }
  }

  loader.addConfig(configFromCommand(command));
  loader.assignConfig();

  const allFiles = await collectFiles(testDir);
  const testFiles = filterFiles(testDir, allFiles, command.args.slice(1), loader.config().testMatch, loader.config().testIgnore);
  const fixtureFiles = filterFiles(testDir, allFiles, [], loader.config().fixtureMatch, loader.config().fixtureIgnore);
  for (const file of fixtureFiles)
    loader.loadFixtureFile(file);
  loader.validateFixtures();
  for (const file of testFiles)
    loader.loadTestFile(file);

  const reporter = new Multiplexer(reporterObjects);
  const runner = new Runner(loader, reporter);

  if (command.list) {
    runner.list();
    return;
  }

  const result = await runner.run();
  if (result === 'sigint')
    process.exit(130);

  if (result === 'forbid-only') {
    console.error('=====================================');
    console.error(' --forbid-only found a focused test.');
    console.error('=====================================');
    process.exit(1);
  }
  if (result === 'no-tests') {
    console.error('=================');
    console.error(' no tests found.');
    console.error('=================');
    process.exit(1);
  }
  process.exit(result === 'failed' ? 1 : 0);
}

async function collectFiles(testDir: string): Promise<string[]> {
  const entries: any[] = [];
  let callback: () => void;
  const promise = new Promise<void>(f => callback = f);
  ignore({ path: testDir, ignoreFiles: ['.gitignore'] })
      .on('child', (entry: any) => entries.push(entry))
      .on('end', callback);
  await promise;
  return entries.filter(e => e.type === 'File').sort((a, b) => {
    if (a.depth !== b.depth && (a.dirname.startsWith(b.dirname) || b.dirname.startsWith(a.dirname)))
      return a.depth - b.depth;
    return a.path > b.path ? 1 : (a.path < b.path ? -1 : 0);
  }).map(e => e.path);
}

function filterFiles(base: string, files: string[], filters: string[], filesMatch: string, filesIgnore: string): string[] {
  if (!filesIgnore.includes('/') && !filesIgnore.includes('\\'))
    filesIgnore = '**/' + filesIgnore;
  if (!filesMatch.includes('/') && !filesMatch.includes('\\'))
    filesMatch = '**/' + filesMatch;
  return files.filter(file => {
    file = path.relative(base, file);
    if (filesIgnore && minimatch(file, filesIgnore))
      return false;
    if (filesMatch && !minimatch(file, filesMatch))
      return false;
    if (filters.length && !filters.find(filter => file.includes(filter)))
      return false;
    return true;
  });
}

function addRunnerOptions(program: commander.Command) {
  program = program
      .version('Version ' + /** @type {any} */ (require)('../package.json').version)
      .option('--config <file>', `Configuration file (default: folio.config.ts or folio.config.js)`)
      .option('--forbid-only', `Fail if exclusive test(s) encountered (default: ${defaultConfig.forbidOnly})`)
      .option('-g, --grep <grep>', `Only run tests matching this string or regexp (default: "${defaultConfig.grep}")`)
      .option('--global-timeout <timeout>', `Specify maximum time this test suite can run in milliseconds (default: 0 for unlimited)`)
      .option('--fixture-ignore <pattern>', `Pattern used to ignore fixture files (default: "${defaultConfig.fixtureIgnore}")`)
      .option('--fixture-match <pattern>', `Pattern used to find fixture files (default: "${defaultConfig.fixtureMatch}")`)
      .option('-h, --help', `Display help`)
      .option('-j, --workers <workers>', `Number of concurrent workers, use 1 to run in single worker (default: number of CPU cores / 2)`)
      .option('--list', `Only collect all the test and report them`)
      .option('--max-failures <N>', `Stop after the first N failures (default: ${defaultConfig.maxFailures})`)
      .option('--output <dir>', `Folder for output artifacts (default: "test-results")`)
      .option('--quiet', `Suppress stdio`)
      .option('--repeat-each <repeat-each>', `Specify how many times to run the tests (default: ${defaultConfig.repeatEach})`)
      .option('--reporter <reporter>', `Specify reporter to use, comma-separated, can be ${availableReporters}`, process.env.CI ? 'dot' : 'line')
      .option('--retries <retries>', `Specify retry count (default: ${defaultConfig.retries})`)
      .option('--shard <shard>', `Shard tests and execute only selected shard, specify in the form "current/all", 1-based, for example "3/5"`)
      .option('--snapshot-dir <dir>', `Snapshot directory, relative to tests directory (default: "${defaultConfig.snapshotDir}"`)
      .option('--test-ignore <pattern>', `Pattern used to ignore test files (default: "${defaultConfig.testIgnore}")`)
      .option('--test-match <pattern>', `Pattern used to find test files (default: "${defaultConfig.testMatch}")`)
      .option('--timeout <timeout>', `Specify test timeout threshold in milliseconds (default: ${defaultConfig.timeout})`)
      .option('-u, --update-snapshots', `Whether to update snapshots with actual results (default: ${defaultConfig.updateSnapshots})`)
      .option('-x', `Stop after the first failure`);
}

function configFromCommand(command: any): PartialConfig {
  const config: PartialConfig = {};
  if (command.forbidOnly)
    config.forbidOnly = true;
  if (command.globalTimeout)
    config.globalTimeout = parseInt(command.globalTimeout, 10);
  if (command.grep)
    config.grep = command.grep;
  if (command.maxFailures || command.x)
    config.maxFailures = command.x ? 1 : parseInt(command.maxFailures, 10);
  if (command.output)
    config.outputDir = command.output;
  if (command.quiet)
    config.quiet = command.quiet;
  if (command.repeatEach)
    config.repeatEach = parseInt(command.repeatEach, 10);
  if (command.retries)
    config.retries = parseInt(command.retries, 10);
  if (command.shard) {
    const pair = command.shard.split('/').map((t: string) => parseInt(t, 10));
    config.shard = { current: pair[0] - 1, total: pair[1] };
  }
  if (command.snapshotDir)
    config.snapshotDir = command.snapshotDir;
  if (command.testMatch)
    config.testMatch = command.testMatch;
  if (command.testIgnore)
    config.testIgnore = command.testIgnore;
  if (command.fixtureMatch)
    config.fixtureMatch = command.fixtureMatch;
  if (command.fixtureIgnore)
    config.fixtureIgnore = command.fixtureIgnore;
  if (command.timeout)
    config.timeout = parseInt(command.timeout, 10);
  if (command.updateSnapshots)
    config.updateSnapshots = !!command.updateSnapshots;
  if (command.workers)
    config.workers = parseInt(command.workers, 10);
  return config;
}
