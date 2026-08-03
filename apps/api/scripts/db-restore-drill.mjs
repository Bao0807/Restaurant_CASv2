import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, open, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: new URL('../.env', import.meta.url), override: false });

const BACKUP_MARKER = 'CAS_RESTORE_DRILL_BACKUP_V1';
const DRILL_NAME_PATTERN = /(^|_)restore_drill(_|$)/i;

function printHelp() {
  console.log(`CAS MySQL restore verification drill

Usage:
  npm run db:restore:drill -- --backup <backup.sql> --target-db <new_restore_drill_database> [options]

Required:
  --backup <path>          SQL file created by db:backup. Its adjacent .sha256 file is required.
  --target-db <name>       Explicit, NEW database name containing "restore_drill".

Options:
  --mysql-bin <path>       mysql executable (default: MYSQL_BIN or mysql).
  --dry-run                Verify the file and print the plan without connecting or restoring.
  --help                   Show this help.

Safety rules:
  * Restore only a trusted dump and its checksum produced by db:backup.
  * The target cannot equal DB_NAME or the source database recorded in the backup.
  * The target must not already exist. This script never drops or overwrites a database.
  * A successful restore is followed by the repository's READ ONLY database audit.

Restore credentials use RESTORE_DB_HOST, RESTORE_DB_PORT, RESTORE_DB_USER and
RESTORE_DB_PASSWORD when set, otherwise the corresponding DB_* values.`);
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
    if (!['--backup', '--target-db', '--mysql-bin'].includes(name)) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`${name} requires a value.`);
    }
    if (inlineValue === undefined) index += 1;

    if (name === '--backup') options.backup = value;
    if (name === '--target-db') options.targetDatabase = value;
    if (name === '--mysql-bin') options.mysqlBin = value;
  }

  return options;
}

function validateDatabaseName(value, label) {
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(value || '')) {
    throw new Error(`${label} may contain only letters, numbers and underscores (maximum 64 characters).`);
  }
  return value;
}

function readConnectionConfig() {
  const port = Number(process.env.RESTORE_DB_PORT || process.env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('RESTORE_DB_PORT/DB_PORT must be an integer from 1 to 65535.');
  }

  return {
    host: process.env.RESTORE_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port,
    user: process.env.RESTORE_DB_USER || process.env.DB_USER || 'root',
    password: process.env.RESTORE_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '',
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readBackupMetadata(path) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString('utf8');
    if (!header.includes(`-- ${BACKUP_MARKER}`)) {
      throw new Error(`Backup marker ${BACKUP_MARKER} was not found. Use a dump created by npm run db:backup.`);
    }
    const sourceMatch = header.match(/^-- source_database:\s*([a-zA-Z0-9_]{1,64})\s*$/m);
    if (!sourceMatch) throw new Error('The backup does not contain a valid source_database marker.');
    return { sourceDatabase: sourceMatch[1] };
  } finally {
    await file.close();
  }
}

async function verifyChecksum(backupPath) {
  const checksumPath = `${backupPath}.sha256`;
  await access(checksumPath, fsConstants.R_OK).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`Missing checksum file: ${checksumPath}`);
    throw error;
  });
  const checksumText = await readFile(checksumPath, 'utf8');
  const expected = checksumText.trim().match(/^([a-fA-F0-9]{64})(?:\s|$)/)?.[1]?.toLowerCase();
  if (!expected) throw new Error(`Invalid SHA-256 file: ${checksumPath}`);

  const actual = await sha256File(backupPath);
  if (actual !== expected) {
    throw new Error(`Backup checksum mismatch. Expected ${expected}, received ${actual}.`);
  }
  return actual;
}

async function rejectDatabaseLevelStatements(backupPath) {
  const input = createReadStream(backupPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const forbidden = [
    /^\s*(?:CREATE|ALTER|DROP)\s+(?:DATABASE|SCHEMA)\b/i,
    /^\s*USE\s+(?:`[^`]+`|[a-zA-Z0-9_]+)\s*;/i,
    /^\s*(?:SOURCE\b|\\\.)/i,
    /^\s*(?:GRANT|REVOKE|CREATE\s+USER|ALTER\s+USER|DROP\s+USER)\b/i,
    /^\s*(?:INSTALL|UNINSTALL)\s+(?:PLUGIN|COMPONENT)\b/i,
    /^\s*SET\s+(?:@@\s*)?(?:GLOBAL|PERSIST(?:_ONLY)?)\b/i,
    /^\s*CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:EVENT|PROCEDURE|FUNCTION|TRIGGER)\b/i,
    /^\s*(?:DROP|ALTER|CREATE|TRUNCATE)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?`?[^`.\s]+`?\s*\./i,
    /^\s*(?:INSERT|REPLACE)\s+INTO\s+`?[^`.\s]+`?\s*\./i,
    /^\s*(?:UPDATE|DELETE\s+FROM)\s+`?[^`.\s]+`?\s*\./i,
  ];
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      const executableLine = line
        .replace(/^\s*\/\*!\d*\s*/, '')
        .replace(/\*\/\s*;?\s*$/, '');
      if (forbidden.some(pattern => pattern.test(executableLine))) {
        throw new Error(`Unsafe database-level statement detected at line ${lineNumber}.`);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function mysqlBaseArgs(connection) {
  return [
    '--protocol=TCP',
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--user=${connection.user}`,
    '--default-character-set=utf8mb4',
  ];
}

function redactedCommand(executable, args) {
  return [executable, ...args]
    .map(value => (/\s/.test(value) ? JSON.stringify(value) : value))
    .join(' ');
}

async function runMysqlCapture(executable, args, environment) {
  const child = spawn(executable, args, {
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    if (stdout.length < 16_384) stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    if (stderr.length < 16_384) stderr += chunk;
  });

  const [exitCode, signal] = await Promise.race([
    once(child, 'close'),
    once(child, 'error').then(([error]) => Promise.reject(error)),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || `terminated with ${signal || `exit code ${exitCode}`}`;
    throw new Error(`mysql failed: ${detail}`);
  }
  return stdout.trim();
}

async function restoreBackup(executable, args, environment, backupPath) {
  const child = spawn(executable, args, {
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'inherit', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', chunk => {
    if (stderr.length < 32_768) stderr += chunk;
  });

  const pipePromise = pipeline(createReadStream(backupPath), child.stdin);
  const closePromise = Promise.race([
    once(child, 'close'),
    once(child, 'error').then(([error]) => Promise.reject(error)),
  ]);
  let exitCode;
  let signal;
  try {
    [[exitCode, signal]] = await Promise.all([closePromise, pipePromise]);
  } catch (error) {
    child.kill();
    throw error;
  }
  if (exitCode !== 0) {
    const detail = stderr.trim() || `terminated with ${signal || `exit code ${exitCode}`}`;
    throw new Error(`mysql restore failed: ${detail}`);
  }
}

async function runAudit(connection, targetDatabase) {
  const auditScript = fileURLToPath(new URL('./audit-db.mjs', import.meta.url));
  const child = spawn(process.execPath, [auditScript], {
    env: {
      ...process.env,
      DB_HOST: connection.host,
      DB_PORT: String(connection.port),
      DB_USER: connection.user,
      DB_PASSWORD: connection.password,
      DB_NAME: targetDatabase,
    },
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  const [exitCode, signal] = await Promise.race([
    once(child, 'close'),
    once(child, 'error').then(([error]) => Promise.reject(error)),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Restored database audit failed (${signal || `exit code ${exitCode}`}).`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.backup) throw new Error('--backup is required.');
  if (!options.targetDatabase) throw new Error('--target-db is required.');

  const configuredDatabase = validateDatabaseName(process.env.DB_NAME || 'restaurant_casv2', 'DB_NAME');
  const targetDatabase = validateDatabaseName(options.targetDatabase, '--target-db');
  if (targetDatabase.toLowerCase() === configuredDatabase.toLowerCase()) {
    throw new Error('Refusing to restore into DB_NAME. Supply a separate, new restore-drill database.');
  }
  if (!DRILL_NAME_PATTERN.test(targetDatabase)) {
    throw new Error('--target-db must contain the separate word "restore_drill" (for example restaurant_casv2_restore_drill_20260803).');
  }

  const backupPath = resolve(process.cwd(), options.backup);
  await access(backupPath, fsConstants.R_OK);
  const backupStats = await stat(backupPath);
  if (!backupStats.isFile() || backupStats.size === 0) throw new Error('The backup must be a non-empty regular file.');

  const metadata = await readBackupMetadata(backupPath);
  if (targetDatabase.toLowerCase() === metadata.sourceDatabase.toLowerCase()) {
    throw new Error('Refusing to restore into the source database recorded in the backup.');
  }
  const checksum = await verifyChecksum(backupPath);
  await rejectDatabaseLevelStatements(backupPath);

  const connection = readConnectionConfig();
  const executable = options.mysqlBin || process.env.MYSQL_BIN || 'mysql';
  const baseArgs = mysqlBaseArgs(connection);
  const environment = { ...process.env, MYSQL_PWD: connection.password };

  console.log(`Backup: ${backupPath}`);
  console.log(`Source recorded in backup: ${metadata.sourceDatabase}`);
  console.log(`SHA-256 verified: ${checksum}`);
  console.log(`Restore target: ${connection.user}@${connection.host}:${connection.port}/${targetDatabase}`);

  if (options.dryRun) {
    console.log('\nDRY RUN: no server connection was opened and no database was created.');
    console.log('The real drill will refuse the target if it already exists, create it once, restore, then run db:audit READ ONLY.');
    console.log(redactedCommand(executable, [...baseArgs, targetDatabase]));
    return;
  }

  const escapedTarget = `\`${targetDatabase}\``;
  const existenceQuery = `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '${targetDatabase}'`;
  const existingDatabase = await runMysqlCapture(
    executable,
    [...baseArgs, '--batch', '--skip-column-names', `--execute=${existenceQuery}`],
    environment,
  );
  if (existingDatabase) {
    throw new Error(`Refusing to restore: target database already exists (${targetDatabase}). Choose a new drill name.`);
  }

  console.log('\nCreating a new, isolated drill database...');
  await runMysqlCapture(
    executable,
    [...baseArgs, `--execute=CREATE DATABASE ${escapedTarget} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`],
    environment,
  );

  try {
    console.log('Restoring backup into the drill database...');
    await restoreBackup(executable, [...baseArgs, targetDatabase], environment, backupPath);
    console.log('Running the READ ONLY integrity audit...');
    await runAudit(connection, targetDatabase);
  } catch (error) {
    console.error(`\nThe drill database ${targetDatabase} was left in place for inspection; this script never drops databases.`);
    throw error;
  }

  console.log('\nRestore drill completed successfully.');
  console.log(`Database ${targetDatabase} was left in place so an operator can inspect it before manual cleanup.`);
}

try {
  await main();
} catch (error) {
  console.error(`\nRestore drill aborted: ${error.message}`);
  process.exitCode = 1;
}
