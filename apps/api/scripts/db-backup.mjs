import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished, pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: new URL('../.env', import.meta.url), override: false });

const BACKUP_MARKER = 'CAS_RESTORE_DRILL_BACKUP_V1';
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function printHelp() {
  console.log(`CAS MySQL backup

Usage:
  npm run db:backup -- --output <path-to-backup.sql> [options]

Required:
  --output <path>          New .sql file to create. Existing files are never overwritten.

Options:
  --mysqldump-bin <path>   mysqldump executable (default: MYSQLDUMP_BIN or mysqldump).
  --dry-run                Validate arguments and print the redacted command only.
  --help                   Show this help.

Database connection is read from apps/api/.env or DB_HOST, DB_PORT, DB_USER,
DB_PASSWORD and DB_NAME in the process environment. The password is passed only
to the child-process environment, never as a command-line argument. Backups must
be written outside the repository to reduce the risk of committing production data.
The application does not use stored routines, events or triggers, so executable
database objects are deliberately excluded from this schema-and-data backup.`);
}

function parseArguments(argv) {
  const options = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    const separatorIndex = argument.indexOf('=');
    const name = separatorIndex >= 0 ? argument.slice(0, separatorIndex) : argument;
    const inlineValue = separatorIndex >= 0 ? argument.slice(separatorIndex + 1) : undefined;
    if (name !== '--output' && name !== '--mysqldump-bin') {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`${name} requires a value.`);
    }
    if (inlineValue === undefined) index += 1;

    if (name === '--output') options.output = value;
    if (name === '--mysqldump-bin') options.mysqldumpBin = value;
  }

  return options;
}

function readDatabaseConfig() {
  const database = process.env.DB_NAME || 'restaurant_casv2';
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(database)) {
    throw new Error('DB_NAME may contain only letters, numbers and underscores (maximum 64 characters).');
  }

  const port = Number(process.env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DB_PORT must be an integer from 1 to 65535.');
  }

  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? '',
    database,
  };
}

function redactedCommand(executable, args) {
  return [executable, ...args]
    .map(value => (/\s/.test(value) ? JSON.stringify(value) : value))
    .join(' ');
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function runDump({ executable, args, environment, outputPath, marker }) {
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  let stderr = '';
  let child;

  try {
    await new Promise((resolveWrite, rejectWrite) => {
      output.write(marker, error => (error ? rejectWrite(error) : resolveWrite()));
    });

    child = spawn(executable, args, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 16_384) stderr += chunk;
    });

    const pipePromise = pipeline(child.stdout, output, { end: false });
    const closePromise = Promise.race([
      once(child, 'close'),
      once(child, 'error').then(([error]) => Promise.reject(error)),
    ]);
    const [[exitCode, signal]] = await Promise.all([closePromise, pipePromise]);

    if (exitCode !== 0) {
      const detail = stderr.trim() || `terminated with ${signal || `exit code ${exitCode}`}`;
      throw new Error(`mysqldump failed: ${detail}`);
    }

    output.end();
    await finished(output);
  } catch (error) {
    child?.kill();
    output.destroy();
    await unlink(outputPath).catch(unlinkError => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.output) throw new Error('--output is required. Run with --help for an example.');

  const databaseConfig = readDatabaseConfig();
  const outputPath = resolve(process.cwd(), options.output);
  if (!outputPath.toLowerCase().endsWith('.sql')) {
    throw new Error('--output must use the .sql extension.');
  }
  const pathFromRepository = relative(REPOSITORY_ROOT, outputPath);
  const outsideRepository = pathFromRepository === '..'
    || pathFromRepository.startsWith(`..${sep}`)
    || isAbsolute(pathFromRepository);
  if (!outsideRepository) {
    throw new Error('Refusing to write database data inside the repository. Choose an external backup directory.');
  }
  const checksumPath = `${outputPath}.sha256`;
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite existing backup: ${outputPath}`);
  if (await pathExists(checksumPath)) throw new Error(`Refusing to overwrite existing checksum: ${checksumPath}`);
  await access(dirname(outputPath), fsConstants.W_OK);

  const executable = options.mysqldumpBin || process.env.MYSQLDUMP_BIN || 'mysqldump';
  const args = [
    '--protocol=TCP',
    `--host=${databaseConfig.host}`,
    `--port=${databaseConfig.port}`,
    `--user=${databaseConfig.user}`,
    '--default-character-set=utf8mb4',
    '--skip-events',
    '--skip-routines',
    '--single-transaction',
    '--quick',
    '--skip-lock-tables',
    '--skip-triggers',
    '--hex-blob',
    '--no-tablespaces',
    '--set-gtid-purged=OFF',
    databaseConfig.database,
  ];
  const createdAt = new Date().toISOString();
  const marker = [
    `-- ${BACKUP_MARKER}`,
    `-- source_database: ${databaseConfig.database}`,
    `-- created_at_utc: ${createdAt}`,
    '-- This dump intentionally contains no CREATE DATABASE or USE statement.',
    '',
  ].join('\n');

  console.log(`Source: ${databaseConfig.user}@${databaseConfig.host}:${databaseConfig.port}/${databaseConfig.database}`);
  console.log(`Backup: ${outputPath}`);
  console.log(`Checksum: ${checksumPath}`);
  if (options.dryRun) {
    console.log('\nDRY RUN: no connection was opened and no file was created.');
    console.log(redactedCommand(executable, args));
    return;
  }

  await runDump({
    executable,
    args,
    outputPath,
    marker,
    environment: { ...process.env, MYSQL_PWD: databaseConfig.password },
  });

  const checksum = await sha256File(outputPath);
  try {
    await writeFile(checksumPath, `${checksum}  ${basename(outputPath)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    throw error;
  }

  console.log('\nBackup completed successfully.');
  console.log(`SHA-256: ${checksum}`);
  console.log('Store both files outside the repository and test them with db:restore:drill.');
}

try {
  await main();
} catch (error) {
  console.error(`\nBackup aborted: ${error.message}`);
  process.exitCode = 1;
}
