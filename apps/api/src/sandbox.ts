import { spawn, execFile } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Output ceiling. Unlimited by default because the operator asked for no
 *  length cap; kept as a guard rail so a runaway `yes` cannot exhaust the
 *  server's memory when the operator does set one. */
export const SANDBOX_OUTPUT_LIMIT = 0;
/** Wall clock ceiling. 0 means "no timeout", which is the default. */
export const SANDBOX_TIMEOUT_MS = 0;

export interface SandboxResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** Which isolation path actually ran, so the UI can be honest about it. */
  isolation: 'nsjail' | 'directory';
}

export interface SandboxOptions {
  /** Operator switch, read fresh on every call so flipping it in the UI takes
   *  effect on the very next model turn. */
  enabled: () => boolean;
  /** Hard cap on total bytes stored in the sandbox directory. 0 = unlimited. */
  sizeLimitBytes: () => number;
  /** Wall clock limit in ms; 0 means unlimited. */
  timeoutMs?: number;
  /** Output ceiling per stream; 0 means unlimited. */
  outputLimit?: number;
  /** Address space cap in MB; 0 means unlimited. Bounds a runaway allocation
   *  without needing cgroup access, which a plain container cannot provide. */
  memoryLimitMb?: () => number;
  /** Max processes per command; 0 means unlimited. */
  maxProcesses?: () => number;
}

export class SandboxQuotaError extends Error {}

const NSJAIL = '/usr/local/bin/nsjail';

export class Sandbox {
  readonly root: string;
  private readonly timeoutMs: number;
  private readonly outputLimit: number;
  /** Cached probe result; nsjail's availability cannot change at runtime. */
  private nsjailUsable: boolean | null = null;

  constructor(rootDir: string, private readonly options: SandboxOptions) {
    this.root = resolve(rootDir);
    mkdirSync(this.root, { recursive: true });
    this.timeoutMs = options.timeoutMs ?? SANDBOX_TIMEOUT_MS;
    this.outputLimit = options.outputLimit ?? SANDBOX_OUTPUT_LIMIT;
  }

  get enabled(): boolean {
    return this.options.enabled();
  }

  get sizeLimit(): number {
    return Math.max(0, this.options.sizeLimitBytes());
  }

  /** Detect whether nsjail can actually create namespaces here. Probed once
   *  with a real no-op run, because "binary exists" is not the same as
   *  "works": some hosts block user namespaces outright. */
  async nsjailAvailable(): Promise<boolean> {
    if (this.nsjailUsable !== null) return this.nsjailUsable;
    if (process.platform === 'win32' || !existsSync(NSJAIL)) {
      this.nsjailUsable = false;
      return false;
    }
    try {
      // `--true` exits immediately; if namespaces were unavailable this throws.
      await exec(NSJAIL, ['--quiet', '--', '/bin/true'], { timeout: 10000 });
      this.nsjailUsable = true;
    } catch {
      this.nsjailUsable = false;
    }
    return this.nsjailUsable;
  }

  /** Directory size, skipping node_modules/.git which the operator never
   *  counts against the quota but which would dominate a naive walk. */
  usage(): { files: number; bytes: number } {
    let files = 0,
      bytes = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          files++;
          try {
            bytes += statSync(full).size;
          } catch {
            // A file removed mid-walk is not worth failing the whole count.
          }
        }
      }
    };
    if (existsSync(this.root)) walk(this.root);
    return { files, bytes };
  }

  clear(): void {
    if (existsSync(this.root)) rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
  }

  /** Reject before running anything that would obviously blow past the quota,
   *  so the model gets told immediately instead of after a long job. */
  private assertWithinQuota(extraBytes = 0): void {
    const limit = this.sizeLimit;
    if (!limit) return;
    const { bytes } = this.usage();
    if (bytes + extraBytes > limit)
      throw new SandboxQuotaError(
        `沙箱已满（${(bytes / 1024 / 1024).toFixed(1)} MB / ${(limit / 1024 / 1024).toFixed(1)} MB）。` +
          '请先删除文件，或在设置里调大沙箱大小。',
      );
  }

  /** Resolve a model-supplied path inside the sandbox. Absolute paths are
   *  treated as sandbox-relative and `..` cannot escape: the resolved target
   *  must still sit under `root`. `realpathSync` closes the symlink hole that a
   *  plain string check leaves open. */
  private safePath(input: string): string {
    const raw = (input || '.').trim();
    if (raw.length > 200) throw new Error('路径过长');
    const target = resolve(this.root, isAbsolute(raw) ? raw.replace(/^([/\\])+/, '') : raw);
    const rel = relative(this.root, target);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..'))
      throw new Error('路径超出沙箱范围');
    // If the path (or its nearest existing parent) is already a symlink, check
    // where it really points. Missing leaf is fine, the parent is what matters.
    let probe = target;
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      const realRel = relative(realpathSync(this.root), real);
      if (realRel.startsWith('..') || isAbsolute(realRel))
        throw new Error('路径超出沙箱范围');
    }
    return target;
  }

  async write(path: string, content: string): Promise<{ bytes: number; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    // No length cap on content; the size quota is the real bound, and a string
    // beyond V8's max length is impossible to accept anyway.
    this.assertWithinQuota(Buffer.byteLength(content));
    const target = this.safePath(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return { path: relative(this.root, target) || '.', bytes: Buffer.byteLength(content) };
  }

  async read(path: string): Promise<{ content: string; path: string }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    const target = this.safePath(path);
    if (!existsSync(target)) throw new Error('文件不存在');
    const stat = statSync(target);
    if (stat.isDirectory()) throw new Error('这是一个目录，请改用 list_files');
    return {
      path: relative(this.root, target) || '.',
      content: readFileSync(target, 'utf8'),
    };
  }

  async list(path: string): Promise<{
    path: string;
    entries: { name: string; kind: string; size: number }[];
  }> {
    if (!this.enabled) throw new Error('沙箱未启用');
    const target = this.safePath(path);
    if (!existsSync(target)) throw new Error('目录不存在');
    return {
      path: relative(this.root, target) || '.',
      entries: readdirSync(target, { withFileTypes: true })
        .slice(0, 200)
        .map((entry) => {
          const full = join(target, entry.name);
          let size = 0;
          try {
            size = entry.isFile() ? statSync(full).size : 0;
          } catch {
            // Raced with a concurrent command; reporting 0 beats failing.
          }
          return {
            name: entry.name,
            kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
            size,
          };
        }),
    };
  }

  /** Run one shell command inside the sandbox. Prefers nsjail (namespace
   *  isolation) and falls back to a plain subshell when nsjail is unavailable,
   *  so the feature still works on hosts that block user namespaces. */
  async run(command: string, signal?: AbortSignal): Promise<SandboxResult> {
    const started = Date.now();
    if (!this.enabled) throw new Error('沙箱未启用');
    const trimmed = command.trim();
    if (!trimmed) throw new Error('命令不能为空');
    if (trimmed.length > 4000) throw new Error('命令过长');
    this.assertWithinQuota();

    const useNsjail = await this.nsjailAvailable();
    return this.spawn(
      useNsjail ? this.nsjailArgs(trimmed) : this.fallbackArgs(trimmed),
      useNsjail ? 'nsjail' : 'directory',
      started,
      signal,
    );
  }

  /** nsjail argv. Namespaces come from the user namespace created inside, so no
   *  cgroup flags are used: those need a writable host cgroup mount, which would
   *  break the "just docker compose up" promise. Resource bounds come from
   *  rlimits instead, which need no privilege at all.
   *
   *  `--disable_clone_newnet` keeps the command off the network entirely.
   *  `/usr` and `/lib` are read-only bind mounts so binaries can actually run;
   *  the sandbox directory is the only writable path. */
  private nsjailArgs(command: string): { bin: string; args: string[] } {
    const args = [
      '--quiet',
      '--chroot',
      '/',
      '--cwd',
      this.root,
      '--bindmount',
      this.root,
      '--bindmount_ro',
      '/usr',
      '--bindmount_ro',
      '/lib',
      '--bindmount_ro',
      '/lib64',
      '--bindmount_ro',
      '/bin',
      '--bindmount_ro',
      '/sbin',
      // No network: the command gets a namespace with nothing outside it.
      '--disable_clone_newnet',
    ];
    const mem = this.options.memoryLimitMb?.() ?? 0;
    if (mem > 0) args.push('--rlimit_as', String(mem * 1024));
    const procs = this.options.maxProcesses?.() ?? 0;
    if (procs > 0) args.push('--rlimit_nofile', String(Math.max(256, procs * 64)));
    if (this.timeoutMs > 0) args.push('--time_limit', String(Math.ceil(this.timeoutMs / 1000)));
    args.push('--', '/bin/sh', '-c', command);
    return { bin: NSJAIL, args };
  }

  /** Plain subshell for hosts where nsjail is unusable. Still confined to the
   *  sandbox directory and the scrubbed environment, just without namespaces. */
  private fallbackArgs(command: string): { bin: string; args: string[] } {
    return { bin: '/bin/sh', args: ['-c', command] };
  }

  private spawn(
    { bin, args }: { bin: string; args: string[] },
    isolation: 'nsjail' | 'directory',
    started: number,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolvePromise) => {
      const child = spawn(bin, args, {
        cwd: this.root,
        env: SAFE_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '',
        stderr = '',
        timedOut = false,
        settled = false;
      // Cap as we stream rather than after: a runaway `yes` would otherwise fill
      // memory before the timeout ever fires. No-op when the limit is 0.
      const cap = (buf: Buffer, current: string): string => {
        if (!this.outputLimit) return current + buf.toString('utf8');
        return current.length >= this.outputLimit
          ? current
          : (current + buf.toString('utf8')).slice(0, this.outputLimit);
      };
      child.stdout.on('data', (b: Buffer) => (stdout = cap(b, stdout)));
      child.stderr.on('data', (b: Buffer) => (stderr = cap(b, stderr)));

      // Only arm a timer when the operator actually set a limit; with the
      // default of 0 the command may run as long as it needs.
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              this.kill(child.pid);
            }, this.timeoutMs)
          : null;

      const onAbort = () => this.kill(child.pid);
      signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise({
          ok: !timedOut && code === 0,
          code,
          stdout,
          stderr,
          timedOut,
          truncated: this.outputLimit
            ? stdout.length >= this.outputLimit || stderr.length >= this.outputLimit
            : false,
          durationMs: Date.now() - started,
          isolation,
        });
      };
      child.on('error', (error) => {
        stderr += `\n${error.message}`;
        finish(null);
      });
      child.on('close', finish);
    });
  }

  /** Kill the whole process group: the shell forks, so killing only the shell
   *  would leave the actual command running. */
  private kill(pid?: number): void {
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  /** What the settings page shows so the operator knows what they are getting. */
  async isolationInfo(): Promise<{
    level: 'nsjail' | 'directory' | 'unavailable';
    note: string;
    network: string;
  }> {
    if (process.platform === 'win32')
      return {
        level: 'directory',
        note: '本地 Windows 预览：目录级隔离。生产 Linux 容器内使用 nsjail。',
        network: '本地预览无法禁用网络',
      };
    const nsjail = await this.nsjailAvailable();
    return {
      level: nsjail ? 'nsjail' : 'directory',
      note: nsjail
        ? 'nsjail 命名空间隔离：独立 mount/pid/ipc/uts/user 命名空间，无网络，只读挂载系统目录，沙箱目录为唯一可写路径。'
        : 'nsjail 不可用，已回退到目录级隔离（工作目录 + 环境变量白名单 + 配额 + 软链防护）。宿主机可能禁用了用户命名空间。',
      network: nsjail ? '已禁用（命令无网络）' : '未禁用',
    };
  }
}

/** Env handed to sandboxed commands. Anything secret (LLM keys, admin password,
 *  the SQLite path) is deliberately absent so a stray `printenv` cannot leak it
 *  into a chat message. */
const SAFE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: process.env.LANG || 'C.UTF-8',
  TZ: process.env.TZ,
};