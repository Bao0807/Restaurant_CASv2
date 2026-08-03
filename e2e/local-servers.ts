import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const API_URL = 'http://127.0.0.1:4100/api/health';
const WEB_URL = 'http://127.0.0.1:5173';
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

type LocalServer = {
  child: ChildProcess;
  label: string;
  spawnError?: Error;
};

const delay = (milliseconds: number) => new Promise(resolve => {
  setTimeout(resolve, milliseconds);
});

async function isAvailable(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

function startServer(
  label: string,
  cwd: string,
  args: string[],
) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const server: LocalServer = { child, label };

  child.once('error', error => {
    server.spawnError = error;
  });
  child.stdout?.on('data', chunk => {
    process.stdout.write(`[E2E ${label}] ${chunk}`);
  });
  child.stderr?.on('data', chunk => {
    process.stderr.write(`[E2E ${label}] ${chunk}`);
  });

  return server;
}

async function waitUntilAvailable(server: LocalServer, url: string) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (server.spawnError) {
      throw new Error(`Không thể khởi động ${server.label}: ${server.spawnError.message}`);
    }
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(
        `${server.label} đã dừng trước khi sẵn sàng (exit ${server.child.exitCode ?? server.child.signalCode}).`,
      );
    }
    if (await isAvailable(url)) {
      return;
    }
    await delay(100);
  }

  throw new Error(`Quá ${STARTUP_TIMEOUT_MS}ms chờ ${server.label} tại ${url}.`);
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>(resolve => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);

    child.once('exit', onExit);
  });
}

async function forceKillWindowsProcessTree(pid: number) {
  await new Promise<void>(resolve => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      killer.kill();
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);

    killer.once('error', finish);
    killer.once('exit', finish);
  });
}

async function stopServer(server: LocalServer) {
  const { child, label } = server;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = waitForExit(child, SHUTDOWN_TIMEOUT_MS);
  child.kill('SIGTERM');
  if (await exited) {
    return;
  }

  if (process.platform === 'win32' && child.pid) {
    await forceKillWindowsProcessTree(child.pid);
  } else {
    child.kill('SIGKILL');
  }

  if (!(await waitForExit(child, SHUTDOWN_TIMEOUT_MS))) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    process.stderr.write(`[E2E ${label}] Không thể xác nhận tiến trình đã dừng; đã tách handle để runner thoát.\n`);
  }
}

export default async function setupLocalServers() {
  const repositoryRoot = path.resolve(__dirname, '..');
  const managedServers: LocalServer[] = [];

  const emergencyStop = () => {
    for (const { child } of managedServers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  };
  process.once('exit', emergencyStop);

  try {
    if (!(await isAvailable(API_URL))) {
      const api = startServer('API', path.join(repositoryRoot, 'apps/api'), ['src/server.js']);
      managedServers.push(api);
      await waitUntilAvailable(api, API_URL);
    }

    if (!(await isAvailable(WEB_URL))) {
      const web = startServer('Web', path.join(repositoryRoot, 'apps/web'), [
        path.join(repositoryRoot, 'node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
      ]);
      managedServers.push(web);
      await waitUntilAvailable(web, WEB_URL);
    }
  } catch (error) {
    await Promise.all(managedServers.reverse().map(stopServer));
    process.off('exit', emergencyStop);
    throw error;
  }

  return async () => {
    process.off('exit', emergencyStop);
    await Promise.all(managedServers.reverse().map(stopServer));
  };
}
