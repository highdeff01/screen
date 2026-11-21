import fs from 'node:fs';
import path from 'node:path';
import { DATA, HISTORY_FILE, db, persist, recordUsage, ROOT, uid, now, writeFileAtomic } from './store.js';
import { buildChatContext, estimateTokens, extractiveSummary } from './context.js';
import { ensureGateway } from './gateway.js';
import { localChat } from './local-model.js';

const LEGACY_HISTORY = path.join(ROOT, 'conversation_history.txt');
let cachedHistory = null;

function readHistory() {
  if (cachedHistory) return cachedHistory;
  for (const file of [HISTORY_FILE, LEGACY_HISTORY]) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const messages = parsed.filter(
          (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
        );
        if (file !== HISTORY_FILE) writeFileAtomic(HISTORY_FILE, JSON.stringify(messages, null, 2));
        cachedHistory = messages;
        return messages;
      }
    } catch (err) {
      console.warn('[llm] could not load history from', file, err.message);
    }
  }
  cachedHistory = [];
  return [];
}

export function getHistory() {
  return readHistory();
}

export function saveHistory(messages) {
  const all = Array.isArray(messages) ? messages : [];
  writeFileAtomic(HISTORY_FILE, JSON.stringify(all, null, 2));
  cachedHistory = all;
  return all;
}

export function clearHistory() {
  saveHistory([]);
  const memory = memoryState();
  memory.conversation = { summaries: [], covered: 0 };
  persist();
}

function memoryState() {
  const d = db();
  if (!d.memory || typeof d.memory !== 'object') d.memory = { conversation: { summaries: [], covered: 0 }, docs: [] };
  if (!d.memory.conversation) d.memory.conversation = { summaries: [], covered: 0 };
  if (!Array.isArray(d.memory.conversation.summaries)) d.memory.conversation.summaries = [];
  if (!Number.isFinite(Number(d.memory.conversation.covered))) d.memory.conversation.covered = 0;
  if (!Array.isArray(d.memory.docs)) d.memory.docs = [];
  return d.memory;
}

export function getMemoryStats() {
  const history = getHistory();
  const memory = memoryState();
  const summaries = memory.conversation.summaries;
  return {
    historyMessages: history.length,
    historyTokens: history.reduce((total, message) => total + estimateTokens(message.content) + 6, 0),
    summaryCount: summaries.length,
    coveredMessages: Math.min(history.length, memory.conversation.covered || 0),
    unsummarizedMessages: Math.max(0, history.length - (memory.conversation.covered || 0)),
    summaryTokens: summaries.reduce((total, item) => total + estimateTokens(item.text), 0),
    lastSummaryAt: summaries[summaries.length - 1]?.at || null,
    documents: memory.docs.length,
    documentTokens: memory.docs.reduce((total, item) => total + Number(item.tokens || 0), 0),
    recentSummaries: summaries.slice(-8).reverse(),
    recentDocuments: memory.docs.slice(0, 8),
  };
}

function useOpenAi(settings) {
  return settings.apiStyle === 'openai' || /\/v1\//.test(String(settings.chatPath || ''));
}

/**
 * Consume a streamed completion (Ollama NDJSON or OpenAI SSE) and return the
 * assembled text plus the only timing that changes how a call feels: how long
 * until the first token arrived.
 */
async function readCompletionStream(res, options = {}) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const data = await res.json();
    const whole = String(data?.choices?.[0]?.message?.content ?? data?.message?.content ?? data?.response ?? '');
    return { content: whole, ttftMs: 0, chunks: whole ? 1 : 0 };
  }
  const decoder = new TextDecoder();
  const started = Date.now();
  const state = { content: '', chunks: 0, ttftMs: null };
  let buffer = '';
  const emit = (piece) => {
    if (!piece) return;
    if (state.ttftMs === null) state.ttftMs = Date.now() - started;
    state.chunks += 1;
    state.content += piece;
    try {
      options.onToken?.(piece, { content: state.content });
    } catch {}
  };
  const handleLine = (raw) => {
    const line = String(raw || '').trim();
    if (!line) return;
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload || payload === '[DONE]') return;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    emit(
      String(
        data?.choices?.[0]?.delta?.content ??
          data?.choices?.[0]?.message?.content ??
          data?.message?.content ??
          data?.response ??
          ''
      )
    );
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);
  return { content: state.content, ttftMs: state.ttftMs, chunks: state.chunks };
}

/**
 * One chat completion against the Ollama-compatible endpoint.
 * options: { format, timeoutMs, kind, maxTokens, images, onToken, stream }
 */
export async function chat(messages, options = {}) {
  const settings = db().settings;
  const model = options.model || settings.model;
  const timeoutMs = options.timeoutMs || 60000;
  // The local Respan Gateway fronts the console's own provider when it is
  // enabled; a gateway that cannot start falls back to the direct endpoint so
  // the assistant keeps working.
  const gateway = settings.gatewayEnabled ? await ensureGateway(settings) : null;
  if (settings.gatewayEnabled && !gateway?.ok) {
    console.warn(`[llm] gateway unavailable (${gateway?.error || 'not started'}); calling ${settings.endpoint}`);
  }
  const viaGateway = Boolean(gateway?.ok);
  const endpoint = viaGateway ? `${gateway.url}/v1/chat/completions` : settings.endpoint;
  const openAi = viaGateway || useOpenAi(settings);
  const promptPreview = String(messages[messages.length - 1]?.content || '').slice(0, 160);

  // Reasoning models can spend the whole reply budget on hidden thinking and return
  // empty content. Disable thinking first, retry with a blunt instruction, then retry
  // allowing thinking for models that reject the parameter.
  // Each attempt resends the whole payload. With a screenshot attached that
  // triples the upload, so image calls get two attempts instead of three.
  const attempts = options.images?.length
    ? [
        { think: false, suffix: null },
        { think: undefined, suffix: null },
      ]
    : [
        { think: false, suffix: null },
        { think: false, suffix: 'Reply with only the final answer. No prose, no markdown fences.' },
        { think: undefined, suffix: null },
      ];
  const started = Date.now();
  let lastError = 'Empty response from model';

  for (const attempt of attempts) {
    const baseMessages = attempt.suffix ? [...messages, { role: 'system', content: attempt.suffix }] : messages;
    let imageTarget = -1;
    if (options.images?.length) {
      for (let i = baseMessages.length - 1; i >= 0; i--) {
        if (baseMessages[i].role === 'user') {
          imageTarget = i;
          break;
        }
      }
    }
    let payloadMessages =
      imageTarget >= 0
        ? baseMessages.map((message, index) => (index === imageTarget ? { ...message, images: options.images } : message))
        : baseMessages;
    if (openAi && imageTarget >= 0) {
      payloadMessages = payloadMessages.map((message) => {
        if (!message.images?.length) return message;
        const { images, ...rest } = message;
        return {
          ...rest,
          content: [
            { type: 'text', text: message.content || '' },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: { url: /^data:/.test(image) ? image : `data:image/png;base64,${image}` },
            })),
          ],
        };
      });
    }
    const maxTokens = Math.max(256, Math.min(32768, Number(options.maxTokens) || 8192));
    // Streaming is opt-in: callers that render progressively pass onToken.
    const streaming = Boolean(options.onToken || options.stream);
    const body = openAi
      ? { model, messages: payloadMessages, stream: streaming, temperature: options.temperature ?? 0.3, max_tokens: maxTokens }
      : {
          model,
          messages: payloadMessages,
          stream: streaming,
          // Keep the model resident between steps: an idle server unloads it and
          // the next call pays a full load before it can answer.
          keep_alive: '30m',
          options: {
            temperature: options.temperature ?? 0.3,
            num_predict: maxTokens,
            num_ctx: Math.max(4096, Math.min(131072, Number(options.numCtx) || 16384)),
          },
        };
    if (!openAi) {
      if (attempt.think === false) body.think = false;
      if (options.format === 'json') body.format = 'json';
    } else if (options.format === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastError = `Endpoint ${res.status}: ${text.slice(0, 300)}`;
        if (!openAi && attempt.think === false && res.status === 400 && /think/i.test(text)) continue;
        break;
      }
      let content = '';
      let streamed = null;
      if (streaming) {
        // A stream can start fine and still deliver nothing usable, so the empty
        // reply fallbacks below keep working on the reconstructed text.
        streamed = await readCompletionStream(res, options);
        content = String(streamed.content || '').trim();
      } else {
        const data = await res.json();
        content = String(data?.choices?.[0]?.message?.content ?? data?.message?.content ?? data?.response ?? '').trim();
      }
      if (!content) {
        lastError = 'Empty response from model';
        continue;
      }
      const ms = Date.now() - started;
      const decodeMs = streamed ? Math.max(1, ms - (streamed.ttftMs ?? ms)) : 0;
      recordUsage({
        kind: options.kind || 'chat',
        model,
        ok: true,
        via: viaGateway ? 'gateway' : undefined,
        ms,
        prompt: promptPreview,
        reply: content.slice(0, 200),
        streamed: streaming || undefined,
        ttftMs: streamed?.ttftMs ?? undefined,
        chunks: streamed?.chunks || undefined,
        tps: streamed?.chunks ? Number((streamed.chunks / (decodeMs / 1000)).toFixed(1)) : undefined,
        imageBytes: options.images?.[0] ? Math.round(String(options.images[0]).length * 0.75) : undefined,
      });
      return { ok: true, content, ms, model, ttftMs: streamed?.ttftMs ?? null, chunks: streamed?.chunks ?? null };
    } catch (err) {
      lastError = err.name === 'AbortError' ? 'Request timed out' : err.message;
      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Local backup: the configured endpoint could not answer, so a GGUF model on
  // this machine (llama.cpp) or a local Ollama takes the call instead.
  if (db().settings.localModelEnabled !== false) {
    const local = await localChat(messages, options).catch(() => null);
    if (local?.ok) return local;
    if (local?.error) console.warn(`[llm] local backup unavailable: ${local.error}`);
  }

  const ms = Date.now() - started;
  recordUsage({
    kind: options.kind || 'chat',
    model,
    ok: false,
    via: viaGateway ? 'gateway' : undefined,
    ms,
    prompt: promptPreview,
    error: String(lastError).slice(0, 300),
  });
  return { ok: false, error: lastError, ms, model };
}

export async function chatWithProjectMemory(userMessage) {
  const history = getHistory();
  const settings = db().settings;
  const memory = memoryState();
  const system = {
    role: 'system',
    content:
      'You are the assistant inside Sightline, a desktop screen-automation console running on Windows. ' +
      'You help design UI test workflows built from these steps: launchApp, openUrl, focusWindow, move, click, ' +
      'doubleClick, rightClick, scroll, type, key (shortcuts like ctrl+a/ctrl+c), clipboard, aiExtract, wait, screenshot, verifyScreen, verifyPlayback, mediaHold, expect, playMedia, closeWindow, runTool, note, writeNote, readNote, copyLink, downloadMedia, saveImage, writeTextFile, recordVideo, watchVideo, installApp, testApp. ' +
      'Never substitute Notepad or another app for the app the user names; use the actual app/process. ' +
      'Be concrete and brief. When asked for actions, describe them as workflow steps. ' +
      'Never claim a step already ran; the user runs workflows explicitly.',
  };
  const documentMemories = (memory.docs || []).map((doc) => ({
    at: doc.at,
    text: `File memory (${doc.path}): ${doc.summary}`,
  }));
  const context = buildChatContext(history, userMessage, [...memory.conversation.summaries, ...documentMemories]);
  const messages = [system, ...context.messages, { role: 'user', content: userMessage }];
  const reply = await chat(messages, { kind: 'chat', timeoutMs: 90000 });
  if (reply.ok) {
    saveHistory([...history, { role: 'user', content: userMessage }, { role: 'assistant', content: reply.content }]);
    if (history.length + 2 - (memory.conversation.covered || 0) >= 18) {
      summarizeConversation({ maxChunks: 2 }).catch((err) => console.warn('[memory] summary failed:', err.message));
    }
  }
  persist();
  return { ...reply, context: context.stats };
}

let summaryBusy = null;

/** Summarize older unsummarized turns into durable rolling memory. */
export function summarizeConversation(options = {}) {
  if (summaryBusy) return summaryBusy;
  summaryBusy = (async () => {
    const history = getHistory();
    const memory = memoryState();
    if (memory.conversation.covered > history.length) memory.conversation.covered = 0;
    const target = Math.max(0, history.length - 8);
    const maxChunks = Math.max(1, Math.min(12, Number(options.maxChunks) || 4));
    const created = [];
    let chunks = 0;
    while (memory.conversation.covered + 8 < target && chunks < maxChunks) {
      const from = memory.conversation.covered;
      const to = Math.min(target, from + 24);
      const batch = history.slice(from, to);
      if (!batch.length) break;
      const transcript = batch
        .map((message, index) => `${from + index + 1}. ${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(message.content || '').slice(0, 1600)}`)
        .join('\n\n');
      let summaryText = '';
      try {
        const reply = await chat(
          [
            {
              role: 'system',
              content:
                'Compress this conversation segment into durable memory for a desktop-automation assistant. ' +
                'Preserve goals, decisions, constraints, app names, file paths, commands, errors, numbers, unresolved tasks and user preferences. ' +
                'Drop greetings and repetition. Write one compact paragraph of at most 220 words. Plain text only.',
            },
            { role: 'user', content: transcript },
          ],
          { kind: 'memory', timeoutMs: 60000, temperature: 0.1 }
        );
        if (reply.ok) summaryText = reply.content.trim();
      } catch {}
      if (!summaryText) summaryText = extractiveSummary(transcript, 1200);
      if (!summaryText) break;
      const entry = {
        id: uid('mem'),
        at: now(),
        from,
        to,
        count: to - from,
        tokens: estimateTokens(summaryText),
        text: summaryText.slice(0, 2600),
      };
      memory.conversation.summaries.push(entry);
      memory.conversation.covered = to;
      created.push(entry);
      chunks++;
      persist();
    }
    persist();
    return {
      ok: true,
      created: created.length,
      summaries: created,
      covered: memory.conversation.covered,
      remaining: Math.max(0, history.length - memory.conversation.covered),
    };
  })().finally(() => {
    summaryBusy = null;
  });
  return summaryBusy;
}

export function tagsUrl() {
  const s = db().settings;
  if (useOpenAi(s)) {
    const base = String(s.baseUrl || s.endpoint || '')
      .replace(/\/+$/, '')
      .replace(/\/v1\/models$/, '')
      .replace(/\/models$/, '');
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/models`;
  }
  if (s.baseUrl) return `${String(s.baseUrl).replace(/\/+$/, '')}/api/tags`;
  return String(s.endpoint).replace(/\/api\/chat.*$/, '/api/tags');
}

let modelCache = { at: 0, models: [], url: '' };

export async function listModels(force = false) {
  const openAi = useOpenAi(db().settings);
  const url = tagsUrl();
  if (!force && modelCache.url === url && Date.now() - modelCache.at < 60000 && modelCache.models.length) {
    return { ok: true, models: modelCache.models, url, cached: true };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `Models route returned ${res.status}`, url };
    const data = await res.json();
    const models = (openAi ? data.data || [] : data.models || [])
      .map((m) =>
        openAi
          ? {
              name: m.id,
              size: 0,
              family: m.owned_by || 'local',
              parameterSize: '',
              contextLength: null,
              capabilities: [],
            }
          : {
              name: m.name,
              size: m.size || 0,
              family: m.details?.family || '',
              parameterSize: m.details?.parameter_size || '',
              contextLength: m.details?.context_length || null,
              capabilities: m.capabilities || [],
            }
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    modelCache = { at: Date.now(), models, url };
    return { ok: true, models, url };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'Timed out reaching the model server' : err.message,
      url,
    };
  }
}

export async function health() {
  const settings = db().settings;
  const started = Date.now();
  const res = await listModels();
  if (!res.ok) return { online: false, error: res.error, url: res.url };
  return {
    online: true,
    model: settings.model,
    modelPresent: res.models.some((m) => m.name === settings.model),
    models: res.models.length,
    url: res.url,
    ms: Date.now() - started,
  };
}

/** Extract the first JSON object/array from model output. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.search(/[[{]/);
  if (start === -1) return null;
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export { DATA };
