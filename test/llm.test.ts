// Exercises the real Claude SDK against a local server that speaks the Messages API wire format.
// This checks the request this project sends and how it reads the streamed reply, without an API key.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Brain } from '../src/core/brain.js';
import { KnowledgeBase } from '../src/core/kb.js';
import { AnthropicLlm } from '../src/core/llm.js';
import { DEFAULT_PRICES } from '../src/core/pricing.js';
import { MemoryStore } from '../src/core/store.js';
import { SAMPLE_SEGMENTS, sampleMeeting, seg } from './helpers.js';

interface Captured {
  headers: IncomingMessage['headers'];
  body: Record<string, any>;
}

let server: Server;
let baseURL: string;
const captured: Captured[] = [];
let respond: (body: Record<string, any>, res: ServerResponse, index: number) => void;

function sse(res: ServerResponse, events: Record<string, unknown>[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function streamOf(texts: string[], stopReason: string, usage: Record<string, unknown>) {
  return [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...texts.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 21 } },
    { type: 'message_stop' },
  ];
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      captured.push({ headers: req.headers, body });
      respond(body, res, captured.length - 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const persona = { name: 'Claude', organisation: 'Imperial Edutech' };
const models = { live: 'claude-haiku-5-5', chat: 'claude-sonnet-5-5', recap: 'claude-sonnet-5-5' };

describe('AnthropicLlm against the Messages API wire format', () => {
  it('sends a cacheable streaming request and reads text and usage from the stream', async () => {
    captured.length = 0;
    respond = (_body, res) => sse(res, streamOf(['You told Jordan ', 'about batch one. ', 'She will publish it on Monday.'], 'end_turn', { input_tokens: 420, cache_creation_input_tokens: 0, cache_read_input_tokens: 3100 }));
    const llm = new AnthropicLlm({ apiKey: 'test-key', baseURL, maxRetries: 0 });
    const brain = new Brain({ llm, store: new MemoryStore(), kb: new KnowledgeBase(), persona, prices: DEFAULT_PRICES, models, webSearch: true });
    const many = Array.from({ length: 125 }, (_, i) => seg(i, 'Alex Morgan', `Point ${i}.`, i * 4));
    const sentences: string[] = [];
    const result = await brain.answerLive({ meeting: sampleMeeting(), segments: many, question: 'what did I explain to Jordan?', asker: { name: 'Alex Morgan', trusted: true }, channel: 'voice', onSentence: (s) => sentences.push(s) });

    expect(sentences).toEqual(['You told Jordan about batch one.', 'She will publish it on Monday.']);
    expect(result.usage).toEqual({ inputTokens: 420, outputTokens: 21, cacheWriteTokens: 0, cacheReadTokens: 3100, webSearches: 0 });
    expect(result.costUsd).toBeCloseTo(420 * 0.1e-6 + 21 * 0.5e-6 + 3100 * 0.01e-6, 12);

    const { headers, body } = captured[0] as Captured;
    // Depending on its version the SDK sends the key as x-api-key or as a bearer token.
    expect(String(headers['x-api-key'] ?? headers.authorization)).toContain('test-key');
    expect(headers['anthropic-version']).toBeTruthy();
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1024);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.system).toHaveLength(1);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
    const content = body.messages[0].content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(content.map((b) => Boolean(b.cache_control))).toEqual([false, true, false, false]);
    expect(content[1]?.text.split('\n')).toHaveLength(120);
    expect(content[3]?.text).toContain('Question from Alex Morgan: what did I explain to Jordan?');
    // Spoken answers on Haiku skip thinking for speed.
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('continues a turn that the API paused for a server side tool', async () => {
    captured.length = 0;
    respond = (_body, res, index) =>
      index === 0
        ? sse(res, streamOf(['Let me check. '], 'pause_turn', { input_tokens: 100, server_tool_use: { web_search_requests: 1 } }))
        : sse(res, streamOf(['The answer is forty two.'], 'end_turn', { input_tokens: 150 }));
    const llm = new AnthropicLlm({ apiKey: 'k', baseURL, maxRetries: 0 });
    const result = await llm.stream({ model: 'claude-haiku-5-5', system: [], messages: [{ role: 'user', content: 'q' }], maxTokens: 100 }, () => undefined);
    expect(result.text).toBe('Let me check. The answer is forty two.');
    expect(result.usage.inputTokens).toBe(250);
    expect(result.usage.webSearches).toBe(1);
    expect(captured).toHaveLength(2);
    expect(captured[1]?.body.messages).toHaveLength(2);
    expect(captured[1]?.body.messages[1].role).toBe('assistant');
  });

  it('asks for the recap as structured output and parses the JSON reply', async () => {
    captured.length = 0;
    respond = (_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify({ title: 'Sync', summary: 'A summary.', decisions: [], actions: [], explained: [], openQuestions: ['Who signs off?'] }), citations: null }],
          usage: { input_tokens: 900, output_tokens: 80 },
        }),
      );
    };
    const llm = new AnthropicLlm({ apiKey: 'k', baseURL, maxRetries: 0 });
    const brain = new Brain({ llm, store: new MemoryStore(), kb: new KnowledgeBase(), persona, prices: DEFAULT_PRICES, models, webSearch: false });
    const { recap, costUsd } = await brain.buildRecap(sampleMeeting(), SAMPLE_SEGMENTS);
    expect(recap).toMatchObject({ title: 'Sync', summary: 'A summary.', openQuestions: ['Who signs off?'] });
    expect(costUsd).toBeCloseTo(900 * 2e-6 + 80 * 10e-6, 12);
    const body = (captured[0] as Captured).body;
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.stream).toBeUndefined();
    // Sonnet 5.5 rejects a forced tool call with a 400, so the recap uses structured output.
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toContain('explained');
    expect(body.max_tokens).toBeGreaterThanOrEqual(16000);
    expect(body.messages[0].content).toContain('<transcript>');
  });
});
