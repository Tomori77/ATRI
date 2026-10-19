import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { Sandbox, SandboxQuotaError } from '../apps/api/src/sandbox.js';
import { INFO_TOOLS, SANDBOX_TOOLS } from '@atri/core';
import { temporary, cleanup } from './helpers.js';

/** The sandbox ships as nsjail inside the Linux image and only runs on Linux.
 *  Windows is a local preview only, so the command-execution tests skip there
 *  instead of pretending a POSIX shell exists. */
const canRun = process.platform === 'linux';

/** Build a sandbox with the options object the app now uses. */
const make = (
  dir: string,
  patch: Partial<{ enabled: boolean; sizeLimitBytes: number; timeoutMs: number; outputLimit: number }> = {},
) =>
  new Sandbox(join(dir, 'sandbox'), {
    enabled: () => patch.enabled ?? true,
    sizeLimitBytes: () => patch.sizeLimitBytes ?? 0,
    timeoutMs: patch.timeoutMs ?? 0,
    outputLimit: patch.outputLimit ?? 0,
  });

test('沙箱关闭时不执行任何命令', async (t) => {
  const sandbox = make(temporary(t), { enabled: false });
  assert.equal(sandbox.enabled, false);
  await assert.rejects(() => sandbox.run('echo hi'), /沙箱未启用/);
  // 文件接口同样必须拒绝，否则"关了开关但仍可写盘"。
  await assert.rejects(() => sandbox.write('a.txt', 'x'), /沙箱未启用/);
  await assert.rejects(() => sandbox.read('a.txt'), /沙箱未启用/);
  await assert.rejects(() => sandbox.list('.'), /沙箱未启用/);
});

test('沙箱开启时执行命令并返回输出', { skip: !canRun }, async (t) => {
  const sandbox = make(temporary(t));
  const result = await sandbox.run('echo hello-sandbox');
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello-sandbox/);
});

test('沙箱命令在独立目录里执行，不落在项目目录', { skip: !canRun }, async (t) => {
  const dir = temporary(t);
  const sandbox = make(dir);
  const result = await sandbox.run('pwd && echo x > probe.txt && ls');
  assert.equal(result.ok, true, result.stderr);
  assert.ok(existsSync(join(dir, 'sandbox', 'probe.txt')), '文件应写在沙箱目录里');
  assert.ok(
    !existsSync(join(process.cwd(), 'probe.txt')),
    '绝不能在项目根目录留下文件',
  );
});

test('沙箱环境里没有模型密钥', { skip: !canRun }, async (t) => {
  process.env.ATRI_TEST_SECRET = 'super-secret-value';
  cleanup(t, () => {
    delete process.env.ATRI_TEST_SECRET;
  });
  const sandbox = make(temporary(t));
  const result = await sandbox.run('echo "[$ATRI_TEST_SECRET][$LLM_API_KEY][$ADMIN_PASSWORD]"');
  assert.doesNotMatch(result.stdout, /super-secret-value/, '沙箱不能继承凭据类环境变量');
});

test('默认没有时间限制，长命令可以跑完', { skip: !canRun }, async (t) => {
  const sandbox = make(temporary(t));
  // 无超时：不设置 timer，命令自己跑完 4 秒。
  const started = Date.now();
  const result = await sandbox.run('sleep 4');
  assert.equal(result.timedOut, false);
  assert.equal(result.ok, true, result.stderr);
  assert.ok(Date.now() - started >= 3000, '命令应实际运行了完整时长');
});

test('设置时间上限后超时会杀掉并标记 timedOut', { skip: !canRun }, async (t) => {
  // 300ms 代替生产的无限制，确认超时路径本身是通的。
  const sandbox = make(temporary(t), { timeoutMs: 300 });
  const result = await sandbox.run('sleep 60');
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

test('默认输出不受长度限制', { skip: !canRun }, async (t) => {
  const sandbox = make(temporary(t));
  const result = await sandbox.run('head -c 200000 /dev/zero | tr "\\0" "a"');
  assert.equal(result.truncated, false);
  assert.ok(result.stdout.length > 8000, '默认不应截断长输出');
});

test('设置输出上限后才会截断', { skip: !canRun }, async (t) => {
  const sandbox = make(temporary(t), { outputLimit: 5000 });
  const result = await sandbox.run('head -c 100000 /dev/zero | tr "\\0" "a"');
  assert.ok(result.stdout.length <= 5000, `输出应被截断，实际 ${result.stdout.length}`);
  assert.equal(result.truncated, true);
});

test('文件读写列表在沙箱目录内生效', async (t) => {
  const sandbox = make(temporary(t));
  const written = await sandbox.write('notes/today.md', '# 今天');
  assert.equal(written.path, join('notes', 'today.md'));
  assert.equal((await sandbox.read('notes/today.md')).content, '# 今天');
  const listed = await sandbox.list('notes');
  assert.deepEqual(
    listed.entries.map((e) => e.name),
    ['today.md'],
  );
});

test('路径穿越被拒绝', async (t) => {
  const sandbox = make(temporary(t));
  await assert.rejects(() => sandbox.write('../escape.txt', 'x'), /超出沙箱范围/);
  await assert.rejects(() => sandbox.read('../../etc/passwd'), /超出沙箱范围/);
  await assert.rejects(() => sandbox.list('..'), /超出沙箱范围/);
  await assert.rejects(() => sandbox.write('a/../../b.txt', 'x'), /超出沙箱范围/);
});

test('软链逃逸被拒绝', async (t) => {
  const dir = temporary(t);
  const sandbox = make(dir);
  const outside = join(dir, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'top secret', 'utf8');
  // Windows 上没有软链权限的机器直接跳过，逻辑与 Linux 相同。
  let linked = false;
  try {
    symlinkSync(outside, join(dir, 'sandbox', 'link'), 'dir');
    linked = true;
  } catch {
    linked = false;
  }
  if (!linked) return;
  await assert.rejects(() => sandbox.read('link/secret.txt'), /超出沙箱范围/);
  await assert.rejects(() => sandbox.write('link/new.txt', 'x'), /超出沙箱范围/);
});

test('沙箱大小上限会被执行', async (t) => {
  const sandbox = make(temporary(t), { sizeLimitBytes: 1024 * 1024 });
  // 写到接近上限
  await sandbox.write('a.bin', 'x'.repeat(900 * 1024));
  // 再写 200KB 会超限，应当被拒绝
  await assert.rejects(
    () => sandbox.write('b.bin', 'y'.repeat(200 * 1024)),
    (error: unknown) => error instanceof SandboxQuotaError || /沙箱已满/.test(String(error)),
  );
  // 已满时命令也不该执行：模拟别的进程把目录写满，确认 run_command 被挡住，
  // 而不是让它在满盘上继续产出文件。
  writeFileSync(join(sandbox.root, 'overflow.bin'), 'q'.repeat(300 * 1024), 'utf8');
  assert.ok(sandbox.usage().bytes > 1024 * 1024, '目录应已超过上限');
  await assert.rejects(() => sandbox.run('echo hi'), /沙箱已满/);
});

test('沙箱大小为 0 表示不限制', async (t) => {
  const sandbox = make(temporary(t), { sizeLimitBytes: 0 });
  await sandbox.write('big.bin', 'z'.repeat(3 * 1024 * 1024));
  const { bytes } = sandbox.usage();
  assert.ok(bytes >= 3 * 1024 * 1024, '不应因大小被拒绝');
});

test('usage 统计可用于展示配额占用', async (t) => {
  const sandbox = make(temporary(t));
  assert.deepEqual(sandbox.usage(), { files: 0, bytes: 0 });
  await sandbox.write('x/one.txt', 'abc');
  await sandbox.write('x/two.txt', 'de');
  const { files, bytes } = sandbox.usage();
  assert.equal(files, 2);
  assert.equal(bytes, 5);
});

test('沙箱工具只在开关打开时出现在工具列表里', () => {
  const offNames = INFO_TOOLS.map((tool) => tool.name);
  assert.ok(!offNames.includes('run_command'));
  const onNames = [...INFO_TOOLS, ...SANDBOX_TOOLS].map((tool) => tool.name);
  for (const name of ['run_command', 'write_file', 'read_file', 'list_files'])
    assert.ok(onNames.includes(name), name + ' 应在开启时提供');
});

test('沙箱工具名不与已有工具冲突', () => {
  const infoNames = new Set(INFO_TOOLS.map((tool) => tool.name));
  for (const tool of SANDBOX_TOOLS) assert.ok(!infoNames.has(tool.name), tool.name + ' 重名');
});

test('clear 会清空目录', async (t) => {
  const sandbox = make(temporary(t));
  await sandbox.write('gone.txt', 'bye');
  assert.ok(sandbox.usage().files > 0);
  sandbox.clear();
  assert.deepEqual(sandbox.usage(), { files: 0, bytes: 0 });
});

test('isolationInfo 返回可展示的隔离说明', async (t) => {
  const sandbox = make(temporary(t));
  const info = await sandbox.isolationInfo();
  assert.equal(typeof info.note, 'string');
  assert.ok(info.note.length > 0);
  assert.equal(typeof info.network, 'string');
  // 没有 nsjail 的环境下必须诚实地报告降级，而不是谎称已隔离。
  assert.ok(['nsjail', 'directory'].includes(info.level));
});

test('run 会报告实际使用的隔离方式', { skip: !canRun }, async (t) => {
  const sandbox = make(temporary(t));
  const result = await sandbox.run('echo ok');
  assert.ok(['nsjail', 'directory'].includes(result.isolation));
  // 报告的隔离方式必须与实际是否装了 nsjail 一致，不能谎报。
  if (!existsSync('/usr/local/bin/nsjail')) assert.equal(result.isolation, 'directory');
});