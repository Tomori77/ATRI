import test from 'node:test';
import assert from 'node:assert/strict';
import { inQuietHours } from '@atri/core';
import { fixture, FakeModel, completion } from '../helpers.js';

test('跨午夜安静时段、静默时间和每日次数限制', (t) => {
  assert.equal(inQuietHours(1, 23, 8), true);
  assert.equal(inQuietHours(8, 23, 8), false);
  assert.equal(inQuietHours(23, 23, 8), true);
  const f = fixture(t, undefined, { proactiveEnabled: true });
  const now = Date.parse('2026-09-13T06:00:00Z');
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '下周面试', [], now - 8 * 3600000);
  assert.equal(f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now), true);
  assert.equal(
    f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, Date.parse('2026-09-13T16:00:00Z')),
    false,
  );
  f.store.sql
    .prepare('UPDATE peers SET last_proactive_at=? WHERE id=?')
    .run(now - 3600000, 'wechat:p');
  assert.equal(f.runtime.proactiveAllowed(f.store.peer('wechat:p')!, now), false);
});
test('同一天主动联系可跳过，不反复调用模型', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const model = new FakeModel(() => completion({ messages: [], memoryUpdates: [] }));
  const f = fixture(t, model, { proactiveEnabled: true, diaryHour: 23 });
  f.store.ensurePeer('wechat:p', 'wechat', 'p', 'context', true);
  f.store.ingest('wechat:p', 'old', '下周面试', [], now - 8 * 3600000);
  f.runtime.schedule(now);
  await f.runtime.drain();
  f.runtime.schedule(now);
  await f.runtime.drain();
  assert.equal(model.calls.length, 1);
  assert.equal(f.delivered.length, 0);
});

test('开场白任务跳过主动门控，并使用人格开场白作为 prompt 指引', async (t) => {
  const now = Date.parse('2026-09-13T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const model = new FakeModel(() => completion({ messages: ['你好呀，我是新朋友。'] }));
  const f = fixture(t, model);
  // 从未说过话的联系人（last_user_at=0），普通主动门控必然否决
  f.store.ensurePeer('wechat:new', 'wechat', 'new', 'ctx', true);
  f.store.enqueue('wechat:new', 'proactive', 'greeting', { greeting: '嗨，我是亚托莉' });
  await f.runtime.drain();
  assert.equal(f.delivered.length, 1);
  const sent = model.calls[0]!.messages.map((m) => String(m.content)).join('\n');
  assert.match(sent, /第一次主动问候|刚加上好友/);
  assert.match(sent, /嗨，我是亚托莉/);
});
