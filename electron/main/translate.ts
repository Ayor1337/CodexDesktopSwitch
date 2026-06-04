// Translate between OpenAI Responses API (used by Codex) and Chat Completions API (upstream).
// Pure functions, no I/O. See plan: need-a-router-for-giggly-flame.

type Json = Record<string, unknown>;

const NEW_ID = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const asArray = <T>(value: T | T[] | undefined | null): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const asObj = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// ---------------------------------------------------------------------------
// Responses request -> Chat Completions request
// ---------------------------------------------------------------------------

interface ChatMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content?: string | ChatMessageContentPart[] | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ResponsesContentPart {
  type: string;
  text?: string;
  image_url?: string | { url: string; detail?: string };
  file_id?: string;
  detail?: string;
  filename?: string;
  file_data?: string;
}

function translateContentParts(parts: ResponsesContentPart[]): string | ChatMessageContentPart[] {
  const out: ChatMessageContentPart[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text === 'string') out.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image') {
      const url =
        typeof part.image_url === 'string'
          ? part.image_url
          : part.image_url?.url ?? (part.file_id ? `file://${part.file_id}` : undefined);
      if (url) {
        const detail = (typeof part.image_url === 'object' ? part.image_url?.detail : part.detail) ?? undefined;
        out.push({ type: 'image_url', image_url: detail ? { url, detail } : { url } });
      }
    } else if (part.type === 'input_file') {
      // Chat Completions has no first-class file input; degrade to a text reference.
      const ref = part.filename || part.file_id || '[file]';
      out.push({ type: 'text', text: `[file:${ref}]` });
    }
  }
  if (out.length === 1 && out[0].type === 'text') return out[0].text ?? '';
  return out;
}

export function responsesRequestToChat(body: Json): Json {
  const messages: ChatMessage[] = [];

  const instructions = asString(body.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });

  // input can be a plain string OR an array of items
  const rawInput = body.input;
  if (typeof rawInput === 'string') {
    messages.push({ role: 'user', content: rawInput });
  } else if (Array.isArray(rawInput)) {
    for (const rawItem of rawInput) {
      const item = asObj(rawItem);
      if (!item) continue;
      const itemType = asString(item.type);

      if (itemType === 'function_call') {
        const callId = asString(item.call_id) || asString(item.id) || NEW_ID('call');
        const name = asString(item.name) || '';
        const args = asString(item.arguments) ?? JSON.stringify(item.arguments ?? {});
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }]
        });
        continue;
      }

      if (itemType === 'function_call_output') {
        const callId = asString(item.call_id) || asString(item.id) || '';
        const output = asString(item.output) ?? JSON.stringify(item.output ?? '');
        messages.push({ role: 'tool', tool_call_id: callId, content: output });
        continue;
      }

      if (itemType === 'reasoning') {
        // Chat completions has no reasoning input slot; drop silently.
        continue;
      }

      // message (default)
      const role = asString(item.role) || 'user';
      const chatRole: ChatMessage['role'] =
        role === 'developer' ? 'system' : (role as ChatMessage['role']);
      const content = item.content;
      let chatContent: ChatMessage['content'];
      if (typeof content === 'string') {
        chatContent = content;
      } else if (Array.isArray(content)) {
        chatContent = translateContentParts(content as ResponsesContentPart[]);
      } else {
        chatContent = '';
      }
      messages.push({ role: chatRole, content: chatContent });
    }
  }

  const out: Json = { model: body.model, messages };

  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') out.max_tokens = body.max_output_tokens;
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.stream === 'boolean') out.stream = body.stream;
  if (typeof body.parallel_tool_calls === 'boolean') out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.response_format) out.response_format = body.response_format;
  if (body.metadata) out.metadata = body.metadata;
  if (typeof body.user === 'string') out.user = body.user;

  const reasoning = asObj(body.reasoning);
  if (reasoning && typeof reasoning.effort === 'string') {
    out.reasoning_effort = reasoning.effort;
  }

  const tools = asArray(body.tools as unknown);
  if (tools.length > 0) {
    out.tools = tools.map((raw) => {
      const tool = asObj(raw);
      if (!tool) return raw;
      if (tool.type === 'function') {
        // Responses-style flat function tool -> chat nested form.
        if (asObj(tool.function)) return tool;
        const { type: _type, ...rest } = tool;
        return { type: 'function', function: rest };
      }
      return tool;
    });
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    const tcObj = asObj(tc);
    if (tcObj && tcObj.type === 'function' && asString(tcObj.name)) {
      out.tool_choice = { type: 'function', function: { name: tcObj.name } };
    } else {
      out.tool_choice = tc;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Chat Completions response -> Responses response (non-streaming)
// ---------------------------------------------------------------------------

interface ResponsesOutputItem {
  type: 'message' | 'function_call' | 'reasoning';
  id: string;
  status?: string;
  role?: 'assistant';
  content?: Array<{ type: 'output_text'; text: string; annotations?: unknown[] }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: Array<{ type: 'summary_text'; text: string }>;
}

export function chatResponseToResponses(chat: Json, requestBody?: Json): Json {
  const choices = Array.isArray(chat.choices) ? (chat.choices as Json[]) : [];
  const choice = asObj(choices[0]) || {};
  const message = asObj(choice.message) || {};
  const output: ResponsesOutputItem[] = [];

  const reasoningText =
    asString(message.reasoning_content) || asString((message as { reasoning?: unknown }).reasoning);
  if (reasoningText) {
    output.push({
      type: 'reasoning',
      id: NEW_ID('rs'),
      summary: [{ type: 'summary_text', text: reasoningText }]
    });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : [];
  for (const rawCall of toolCalls) {
    const call = asObj(rawCall);
    if (!call) continue;
    const fn = asObj(call.function) || {};
    output.push({
      type: 'function_call',
      id: asString(call.id) || NEW_ID('fc'),
      call_id: asString(call.id) || NEW_ID('call'),
      name: asString(fn.name) || '',
      arguments: asString(fn.arguments) || '',
      status: 'completed'
    });
  }

  const textContent = asString(message.content);
  if (textContent && textContent.length > 0) {
    output.push({
      type: 'message',
      id: NEW_ID('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textContent, annotations: [] }]
    });
  } else if (Array.isArray(message.content)) {
    const parts = (message.content as Json[])
      .map((part) => asString((asObj(part) || {}).text))
      .filter((t): t is string => !!t);
    if (parts.length > 0) {
      output.push({
        type: 'message',
        id: NEW_ID('msg'),
        status: 'completed',
        role: 'assistant',
        content: parts.map((text) => ({ type: 'output_text', text, annotations: [] }))
      });
    }
  }

  const usage = asObj(chat.usage) || {};
  const created = typeof chat.created === 'number' ? chat.created : Math.floor(Date.now() / 1000);

  return {
    id: asString(chat.id) || NEW_ID('resp'),
    object: 'response',
    created_at: created,
    model: asString(chat.model) || asString(requestBody?.model) || '',
    status: 'completed',
    output,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0
    },
    parallel_tool_calls: requestBody?.parallel_tool_calls ?? true,
    metadata: requestBody?.metadata ?? null,
    incomplete_details: null,
    error: null
  };
}

// ---------------------------------------------------------------------------
// Chat Completions SSE stream -> Responses SSE event stream
// ---------------------------------------------------------------------------

interface SseEvent {
  event: string;
  data: string; // already-stringified JSON, or '[DONE]'
}

interface StreamState {
  responseId: string;
  model: string;
  created: number;
  textItemId: string | null;
  textItemIndex: number | null;
  textBuffer: string;
  toolCalls: Map<number, { id: string; callId: string; name: string; args: string; itemIndex: number }>;
  nextOutputIndex: number;
}

function sseEvent(event: string, data: unknown): SseEvent {
  return { event, data: data === '[DONE]' ? '[DONE]' : JSON.stringify(data) };
}

function emitInitial(state: StreamState): SseEvent[] {
  const response = {
    id: state.responseId,
    object: 'response',
    created_at: state.created,
    model: state.model,
    status: 'in_progress',
    output: [],
    usage: null,
    error: null
  };
  return [sseEvent('response.created', { type: 'response.created', response })];
}

function flushText(state: StreamState): SseEvent[] {
  if (state.textItemId === null || state.textItemIndex === null) return [];
  const itemId = state.textItemId;
  const outputIndex = state.textItemIndex;
  const text = state.textBuffer;
  const events: SseEvent[] = [
    sseEvent('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text
    }),
    sseEvent('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] }
    }),
    sseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        type: 'message',
        id: itemId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
      }
    })
  ];
  state.textItemId = null;
  state.textItemIndex = null;
  state.textBuffer = '';
  return events;
}

function ensureTextItem(state: StreamState): SseEvent[] {
  if (state.textItemId !== null) return [];
  const itemId = NEW_ID('msg');
  const outputIndex = state.nextOutputIndex++;
  state.textItemId = itemId;
  state.textItemIndex = outputIndex;
  return [
    sseEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] }
    }),
    sseEvent('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    })
  ];
}

function handleToolCallDeltas(state: StreamState, deltas: Json[]): SseEvent[] {
  const out: SseEvent[] = [];
  for (const rawDelta of deltas) {
    const delta = asObj(rawDelta);
    if (!delta) continue;
    const index = typeof delta.index === 'number' ? delta.index : 0;
    const fn = asObj(delta.function) || {};
    const id = asString(delta.id);
    const name = asString(fn.name);
    const argsDelta = asString(fn.arguments) || '';

    let entry = state.toolCalls.get(index);
    if (!entry) {
      const callId = id || NEW_ID('call');
      const itemId = NEW_ID('fc');
      const outputIndex = state.nextOutputIndex++;
      entry = { id: itemId, callId, name: name || '', args: '', itemIndex: outputIndex };
      state.toolCalls.set(index, entry);
      out.push(
        sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            type: 'function_call',
            id: itemId,
            status: 'in_progress',
            call_id: callId,
            name: entry.name,
            arguments: ''
          }
        })
      );
    } else if (name && !entry.name) {
      entry.name = name;
    }

    if (argsDelta) {
      entry.args += argsDelta;
      out.push(
        sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: entry.id,
          output_index: entry.itemIndex,
          delta: argsDelta
        })
      );
    }
  }
  return out;
}

function flushToolCalls(state: StreamState): SseEvent[] {
  const out: SseEvent[] = [];
  for (const entry of state.toolCalls.values()) {
    out.push(
      sseEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: entry.id,
        output_index: entry.itemIndex,
        arguments: entry.args
      })
    );
    out.push(
      sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: entry.itemIndex,
        item: {
          type: 'function_call',
          id: entry.id,
          status: 'completed',
          call_id: entry.callId,
          name: entry.name,
          arguments: entry.args
        }
      })
    );
  }
  return out;
}

export async function* chatSseToResponsesSse(
  chunks: AsyncIterable<string>,
  requestBody: Json
): AsyncGenerator<SseEvent> {
  const state: StreamState = {
    responseId: NEW_ID('resp'),
    model: asString(requestBody.model) || '',
    created: Math.floor(Date.now() / 1000),
    textItemId: null,
    textItemIndex: null,
    textBuffer: '',
    toolCalls: new Map(),
    nextOutputIndex: 0
  };

  let initialized = false;
  let buffer = '';
  let usage: Json | null = null;
  let finalChat: Json | null = null;

  for await (const chunk of chunks) {
    buffer += chunk;
    let nlIndex: number;
    while ((nlIndex = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, nlIndex).replace(/\r$/, '');
      buffer = buffer.slice(nlIndex + 1);
      if (!rawLine.startsWith('data:')) continue;
      const payload = rawLine.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') break;

      let parsed: Json;
      try {
        parsed = JSON.parse(payload) as Json;
      } catch {
        continue;
      }
      finalChat = parsed;

      if (!initialized) {
        if (asString(parsed.id)) state.responseId = asString(parsed.id) || state.responseId;
        if (asString(parsed.model)) state.model = asString(parsed.model) || state.model;
        if (typeof parsed.created === 'number') state.created = parsed.created;
        for (const evt of emitInitial(state)) yield evt;
        initialized = true;
      }

      const chatUsage = asObj(parsed.usage);
      if (chatUsage) usage = chatUsage;

      const choices = Array.isArray(parsed.choices) ? (parsed.choices as Json[]) : [];
      for (const rawChoice of choices) {
        const choice = asObj(rawChoice);
        if (!choice) continue;
        const delta = asObj(choice.delta) || {};
        const contentDelta = asString(delta.content);
        const toolDeltas = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Json[]) : null;
        const reasoningDelta =
          asString((delta as { reasoning_content?: unknown }).reasoning_content) ||
          asString((delta as { reasoning?: unknown }).reasoning);

        if (reasoningDelta) {
          // Emit reasoning summary delta; keep it lightweight.
          yield sseEvent('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            delta: reasoningDelta
          });
        }

        if (contentDelta) {
          for (const evt of ensureTextItem(state)) yield evt;
          state.textBuffer += contentDelta;
          yield sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: state.textItemId,
            output_index: state.textItemIndex,
            content_index: 0,
            delta: contentDelta
          });
        }

        if (toolDeltas && toolDeltas.length > 0) {
          for (const evt of handleToolCallDeltas(state, toolDeltas)) yield evt;
        }
      }
    }
  }

  if (!initialized) {
    for (const evt of emitInitial(state)) yield evt;
  }

  for (const evt of flushText(state)) yield evt;
  for (const evt of flushToolCalls(state)) yield evt;

  const finalOutput: ResponsesOutputItem[] = [];
  // Rebuild final output snapshot for the completed event.
  for (const entry of state.toolCalls.values()) {
    finalOutput.push({
      type: 'function_call',
      id: entry.id,
      status: 'completed',
      call_id: entry.callId,
      name: entry.name,
      arguments: entry.args
    });
  }

  const completed = {
    type: 'response.completed',
    response: {
      id: state.responseId,
      object: 'response',
      created_at: state.created,
      model: state.model,
      status: 'completed',
      output: finalOutput,
      usage: usage
        ? {
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0
          }
        : null,
      metadata: requestBody.metadata ?? null,
      parallel_tool_calls: requestBody.parallel_tool_calls ?? true,
      incomplete_details: null,
      error: null,
      _finalChunkId: finalChat ? asString(finalChat.id) : undefined
    }
  };
  yield sseEvent('response.completed', completed);
  yield { event: 'done', data: '[DONE]' };
}

export function formatSseEvent(evt: SseEvent): string {
  return `event: ${evt.event}\ndata: ${evt.data}\n\n`;
}
