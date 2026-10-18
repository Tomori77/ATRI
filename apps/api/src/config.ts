import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Store } from '@atri/db';
import type { ModelConfig, ApiFormat } from '@atri/llm';
import type { RuntimeConfig, PromptName } from '@atri/core';

export interface SavedConfig {  baseUrl: string;
  apiKey: string;
  model: string;
  format: ApiFormat;
  vision: boolean;
  tavilyKey: string;
  timeZone: string;
  diaryHour: number;
  proactiveEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  proactiveAfterHours: number;
  contextWindowTokens: number;
  inputBudgetTokens: number;
  maxOutputTokens: number;
  requestTimeoutSeconds: number;
  turnTimeoutSeconds: number;
  temperature: number | null;
  embeddingEnabled: boolean;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  maxConcurrentPeers: number;
  debounceMs: number;
}
const text12k = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000)
    throw new Error('人设需要 1–12000 个字符');
  return value;
};
export class Settings {
  readonly dataDir: string;
  readonly adminPassword: string;
  readonly host: string;
  readonly port: number;
  readonly secureCookie: boolean;
  constructor(
    readonly store: Store,
    readonly root: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.dataDir = resolve(env.DATA_DIR || join(root, 'data'));
    mkdirSync(this.dataDir, { recursive: true });
    this.host = env.HOST || '127.0.0.1';
    this.port = Number(env.PORT || 3000);
    this.secureCookie = env.COOKIE_SECURE === 'true';
    const passwordFile = join(this.dataDir, 'admin-secret.txt');
    if (env.ADMIN_PASSWORD) this.adminPassword = env.ADMIN_PASSWORD;
    else if (existsSync(passwordFile))
      this.adminPassword = readFileSync(passwordFile, 'utf8').trim();
    else {
      this.adminPassword = randomBytes(24).toString('base64url');
      writeFileSync(passwordFile, this.adminPassword + '\n', { mode: 0o600, flag: 'wx' });
    }
    if (this.adminPassword.length < 12) throw new Error('ADMIN_PASSWORD 至少需要 12 个字符');
  }
  config(): SavedConfig {
    const env = this.env;
    const defaults: SavedConfig = {
      baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com',
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || 'deepseek-chat',
      format: (env.LLM_FORMAT || 'openai') as ApiFormat,
      vision: env.LLM_VISION === 'true',
      tavilyKey: env.TAVILY_API_KEY || '',
      timeZone: env.TZ || 'Asia/Shanghai',
      diaryHour: 3,
      proactiveEnabled: false,
      quietStart: 23,
      quietEnd: 8,
      proactiveAfterHours: 6,
      contextWindowTokens: 65536,
      inputBudgetTokens: 24000,
      maxOutputTokens: 3000,
      requestTimeoutSeconds: 45,
      turnTimeoutSeconds: 90,
      temperature: null,
      embeddingEnabled: false,
      embeddingBaseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com',
      embeddingApiKey: env.EMBEDDING_API_KEY || '',
      embeddingModel: '',
      maxConcurrentPeers: 3,
      debounceMs: 800,
    };
    return { ...defaults, ...this.store.getSetting<Partial<SavedConfig>>('config', {}) };
  }
  publicConfig() {
    const { apiKey, tavilyKey, embeddingApiKey, ...rest } = this.config();
    return {
      ...rest,
      hasApiKey: !!apiKey,
      hasTavilyKey: !!tavilyKey,
      hasEmbeddingApiKey: !!embeddingApiKey,
    };
  }
  update(input: Record<string, unknown>) {
    const next = { ...this.config() };
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('设置格式无效');
    for (const field of ['baseUrl', 'model', 'timeZone', 'embeddingBaseUrl', 'embeddingModel'] as const)
      if (typeof input[field] === 'string') next[field] = input[field].trim();
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
    if (typeof input.tavilyKey === 'string' && input.tavilyKey.trim())
      next.tavilyKey = input.tavilyKey.trim();
    if (typeof input.embeddingApiKey === 'string' && input.embeddingApiKey.trim())
      next.embeddingApiKey = input.embeddingApiKey.trim();
    if (input.clearApiKey === true) next.apiKey = '';
    if (input.clearTavilyKey === true) next.tavilyKey = '';
    if (input.clearEmbeddingApiKey === true) next.embeddingApiKey = '';
    if (input.format !== undefined) {
      if (!['openai', 'anthropic', 'gemini'].includes(String(input.format)))
        throw new Error('模型接口格式无效');
      next.format = input.format as ApiFormat;
    }
    for (const key of ['vision', 'proactiveEnabled', 'embeddingEnabled'] as const)
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'boolean') throw new Error('开关格式无效');
        next[key] = input[key];
      }
    for (const key of ['diaryHour', 'quietStart', 'quietEnd', 'proactiveAfterHours'] as const)
      if (input[key] !== undefined) {
        const n = Number(input[key]);
        if (!Number.isInteger(n) || n < 0 || n > (key === 'proactiveAfterHours' ? 168 : 23))
          throw new Error('时间设置无效');
        next[key] = n;
      }
    const url = new URL(next.baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('模型地址需要是没有凭据和查询参数的 HTTP/HTTPS URL');
    if (!next.model || next.model.length > 150) throw new Error('模型名称无效');
    const limits = {
      contextWindowTokens: [8192, 2000000, '模型上下文窗口'],
      inputBudgetTokens: [4096, 1000000, '输入预算'],
      maxOutputTokens: [256, 131072, '输出上限'],
      requestTimeoutSeconds: [10, 300, '单次请求超时'],
      turnTimeoutSeconds: [10, 600, '整轮处理超时'],
    } as const;
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      if (input[key] === undefined) continue;
      const value = input[key],
        [min, max, label] = limits[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
        throw new Error(`${label}需要 ${min}–${max} 之间的整数`);
      next[key] = value;
    }
    if (input.temperature !== undefined) {
      if (
        input.temperature !== null &&
        (typeof input.temperature !== 'number' ||
          !Number.isFinite(input.temperature) ||
          input.temperature < 0 ||
          input.temperature > 2)
      )
        throw new Error('温度需要留空或填写 0–2 之间的数值');
      next.temperature = input.temperature as number | null;
    }
    if (next.format === 'anthropic' && next.temperature !== null && next.temperature > 1)
      throw new Error('Anthropic 的温度请设为 0–1，或留空使用模型默认值');
    if (next.inputBudgetTokens + next.maxOutputTokens + 1024 > next.contextWindowTokens)
      throw new Error('输入预算 + 输出上限 + 1024 token 余量不能超过模型上下文窗口');
    if (next.turnTimeoutSeconds < next.requestTimeoutSeconds)
      throw new Error('整轮处理超时不能短于单次请求超时');
    if (next.embeddingEnabled && !next.embeddingModel)
      throw new Error('启用向量检索需要先填写向量模型名称');
    if (next.embeddingModel) {
      const embedUrl = new URL(next.embeddingBaseUrl);
      if (
        !['http:', 'https:'].includes(embedUrl.protocol) ||
        embedUrl.username ||
        embedUrl.password ||
        embedUrl.search ||
        embedUrl.hash
      )
        throw new Error('向量模型地址需要是没有凭据和查询参数的 HTTP/HTTPS URL');
    }
    if (input.maxConcurrentPeers !== undefined) {
      const n = Number(input.maxConcurrentPeers);
      if (!Number.isInteger(n) || n < 1 || n > 12)
        throw new Error('同时处理的联系人数量需要 1–12 之间的整数');
      next.maxConcurrentPeers = n;
    }
    if (input.debounceMs !== undefined) {
      const n = Number(input.debounceMs);
      if (!Number.isInteger(n) || n < 0 || n > 10000)
        throw new Error('连发合并窗口需要 0–10000 毫秒');
      next.debounceMs = n;
    }
    new Intl.DateTimeFormat('zh-CN', { timeZone: next.timeZone }).format();
    this.store.setSetting('config', next);
    return this.publicConfig();
  }
  model(): ModelConfig {
    const c = this.config();
    return {
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
      format: c.format,
      vision: c.vision,
      maxTokens: c.maxOutputTokens,
      timeoutMs: c.requestTimeoutSeconds * 1000,
      contextWindowTokens: c.contextWindowTokens,
      inputBudgetTokens: c.inputBudgetTokens,
      ...(c.temperature !== null ? { temperature: c.temperature } : {}),
    };
  }
  embedding(): { baseUrl: string; apiKey: string; model: string; timeoutMs: number } {
    const c = this.config();
    return {
      baseUrl: c.embeddingBaseUrl || c.baseUrl,
      apiKey: c.embeddingApiKey,
      model: c.embeddingModel,
      timeoutMs: Math.min(c.requestTimeoutSeconds, 60) * 1000,
    };
  }
  runtime(): RuntimeConfig {
    const c = this.config();
    return {
      ...c,
      contextTokens: c.inputBudgetTokens,
      turnTimeoutMs: c.turnTimeoutSeconds * 1000,
      debounceMs: c.debounceMs,
      maxConcurrentPeers: c.maxConcurrentPeers,
    };
  }
  prompt(name: PromptName): string {
    return this.store.getSetting<string>(
      `prompt:${name}`,
      readFileSync(join(this.root, 'shared', 'prompts', `${name}.md`), 'utf8'),
    );
  }
  savePersona(text: string) {
    if (!text.trim() || text.length > 12000) throw new Error('人设需要 1–12000 个字符');
    this.store.setSetting('prompt:persona', text);
  }
  personaList() {
    let list = this.store.getSetting<
      { id: string; name: string; content: string; createdAt: number }[] | undefined
    >('personas', undefined);
    if (!list) {
      // First run on a database created before multi-persona support: import
      // the single persona as the default entry so nothing is lost.
      const imported: { id: string; name: string; content: string; createdAt: number }[] = [
        {
          id: 'default',
          name: '默认人格',
          content: this.store.getSetting<string>('prompt:persona', this.prompt('persona')),
          createdAt: Date.now(),
        },
      ];
      this.store.setSetting('personas', imported);
      this.store.setSetting('persona:default', 'default');
      list = imported;
    }
    return { list: [...list], defaultId: this.store.getSetting<string>('persona:default', 'default') };
  }
  personaContentFor(peerId: string): string {
    const { list, defaultId } = this.personaList();
    const binding = peerId ? (this.store.peer(peerId)?.persona_id ?? '') : '';
    const id = binding || defaultId;
    return list.find((p) => p.id === id)?.content ?? this.prompt('persona');
  }
  private validatePersonaName(name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 40) throw new Error('人格名称需要 1–40 个字符');
    return trimmed;
  }
  personaCreate(name: string, content: string) {
    const { list } = this.personaList();
    const entry = {
      id: randomBytes(6).toString('base64url'),
      name: this.validatePersonaName(name),
      content: text12k(content),
      createdAt: Date.now(),
    };
    this.store.setSetting('personas', [...list, entry]);
    return entry;
  }
  personaUpdate(id: string, input: { name?: string; content?: string }) {
    const { list } = this.personaList();
    const entry = list.find((p) => p.id === id);
    if (!entry) throw new Error('人格不存在');
    const next = { ...entry };
    if (input.name !== undefined) next.name = this.validatePersonaName(input.name);
    if (input.content !== undefined) next.content = text12k(input.content);
    this.store.setSetting(
      'personas',
      list.map((p) => (p.id === id ? next : p)),
    );
    return next;
  }
  personaDelete(id: string) {
    const { list, defaultId } = this.personaList();
    if (list.length <= 1) throw new Error('至少保留一个人格');
    if (id === defaultId) throw new Error('默认人格不能删除，请先设置其他人格为默认');
    this.store.setSetting(
      'personas',
      list.filter((p) => p.id !== id),
    );
    // Peers bound to the removed persona fall back to the default automatically
    // (binding points at a missing id); clear the dangling bindings anyway.
    for (const peer of this.store.peers())
      if (peer.persona_id === id) this.store.setPeerPersona(peer.id, '');
    return { ok: true };
  }
  personaSetDefault(id: string) {
    const { list } = this.personaList();
    if (!list.some((p) => p.id === id)) throw new Error('人格不存在');
    this.store.setSetting('persona:default', id);
    return { ok: true };
  }
  setPeerPersona(peerId: string, personaId: string) {
    if (!this.store.peer(peerId)) throw new Error('联系人不存在');
    if (personaId) {
      const { list } = this.personaList();
      if (!list.some((p) => p.id === personaId)) throw new Error('人格不存在');
    }
    this.store.setPeerPersona(peerId, personaId);
    return { ok: true };
  }
  allowedPeers() {
    return new Set(
      (this.env.WECHAT_ALLOWED_PEERS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  ilinkBase() {
    return this.env.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com';
  }
}
