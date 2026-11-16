// A thin wrapper around the Claude Messages API. The rest of the code depends on the Llm
// interface, so tests and the local demo can run with a scripted stand in.

import Anthropic from '@anthropic-ai/sdk';
import { type LlmUsage, ZERO_USAGE, addUsage } from './pricing.js';

export type LlmMessage = Anthropic.MessageParam;
export type LlmSystemBlock = Anthropic.TextBlockParam;
export type LlmTool = Anthropic.ToolUnion;
export type LlmContentBlock = Anthropic.ContentBlock;

export interface LlmRequest {
  model: string;
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  maxTokens: number;
  tools?: LlmTool[];
  /**
   * Only "auto" or "none" on Sonnet 5.5, Opus 5.5 and Fable 5.x: they reject forced tool use
   * ("tool" or "any") with a 400. To get JSON back, use outputSchema instead.
   */
  toolChoice?: Anthropic.ToolChoice;
  /** Lower effort gives faster answers. Leave undefined to use the model default. */
  effort?: 'low' | 'medium' | 'high';
  /** Structured output: the reply text is JSON that matches this schema. */
  outputSchema?: { [key: string]: unknown };
  /**
   * "off" turns thinking off for the fastest reply. Only Haiku 5.5 (at effort high or below)
   * accepts this; Sonnet 5.5 and Opus 5.5 reject it with a 400, so callers must check the model.
   */
  thinking?: 'off';
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  content: LlmContentBlock[];
  stopReason: string | null;
  usage: LlmUsage;
}

export interface Llm {
  /** Runs a request and calls onText with each piece of text as it is generated. */
  stream(request: LlmRequest, onText: (delta: string) => void): Promise<LlmResult>;
  /** Runs a request and returns the whole reply. */
  create(request: LlmRequest): Promise<LlmResult>;
}

function usageOf(message: Anthropic.Message): LlmUsage {
  const u = message.usage;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
  };
}

function textOf(content: LlmContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;

  constructor(options: { apiKey: string; baseURL?: string; maxRetries?: number }) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: options.maxRetries ?? 2 });
  }

  private params(request: LlmRequest, messages: LlmMessage[]): Anthropic.MessageCreateParamsNonStreaming {
    const outputConfig: Anthropic.OutputConfig = {
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.outputSchema ? { format: { type: 'json_schema' as const, schema: request.outputSchema } } : {}),
    };
    return {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages,
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(request.thinking === 'off' ? { thinking: { type: 'disabled' as const } } : {}),
    };
  }

  async stream(request: LlmRequest, onText: (delta: string) => void): Promise<LlmResult> {
    // A server side tool such as web search can pause a turn. The API then expects the same
    // conversation back with the partial assistant reply appended, so loop a few times at most.
    let messages = request.messages;
    let usage = ZERO_USAGE;
    let text = '';
    let last: Anthropic.Message | undefined;
    for (let round = 0; round < 3; round++) {
      const stream = this.client.messages.stream(this.params(request, messages), { signal: request.signal });
      stream.on('text', (delta) => {
        text += delta;
        onText(delta);
      });
      last = await stream.finalMessage();
      usage = addUsage(usage, usageOf(last));
      if (last.stop_reason !== 'pause_turn') break;
      messages = [...messages, { role: 'assistant', content: last.content as unknown as Anthropic.ContentBlockParam[] }];
    }
    return { text, content: last?.content ?? [], stopReason: last?.stop_reason ?? null, usage };
  }

  async create(request: LlmRequest): Promise<LlmResult> {
    const message = await this.client.messages.create(this.params(request, request.messages), { signal: request.signal });
    return { text: textOf(message.content), content: message.content, stopReason: message.stop_reason, usage: usageOf(message) };
  }
}

/** Reply used by ScriptedLlm. Either plain text or a tool call. */
export type ScriptedReply =
  | { text: string }
  | { toolName: string; toolInput: unknown };

/**
 * A stand in for the Claude API used by tests and the local demo. The responder receives the
 * request, so a test can assert on what would have been sent.
 */
export class ScriptedLlm implements Llm {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly responder: (request: LlmRequest, callIndex: number) => ScriptedReply) {}

  private run(request: LlmRequest): LlmResult {
    this.requests.push(request);
    const reply = this.responder(request, this.requests.length - 1);
    const promptChars = JSON.stringify(request.system).length + JSON.stringify(request.messages).length;
    const usage: LlmUsage = { ...ZERO_USAGE, inputTokens: Math.ceil(promptChars / 4) };
    if ('text' in reply) {
      usage.outputTokens = Math.ceil(reply.text.length / 4);
      const block = { type: 'text', text: reply.text, citations: null } as unknown as LlmContentBlock;
      return { text: reply.text, content: [block], stopReason: 'end_turn', usage };
    }
    usage.outputTokens = Math.ceil(JSON.stringify(reply.toolInput).length / 4);
    const block = { type: 'tool_use', id: `toolu_${this.requests.length}`, name: reply.toolName, input: reply.toolInput } as unknown as LlmContentBlock;
    return { text: '', content: [block], stopReason: 'tool_use', usage };
  }

  async stream(request: LlmRequest, onText: (delta: string) => void): Promise<LlmResult> {
    const result = this.run(request);
    // Deliver the text in small pieces, as the real API does.
    for (let i = 0; i < result.text.length; i += 12) {
      if (request.signal?.aborted) break;
      onText(result.text.slice(i, i + 12));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return result;
  }

  async create(request: LlmRequest): Promise<LlmResult> {
    return this.run(request);
  }
}
