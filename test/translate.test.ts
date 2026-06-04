import { describe, expect, it } from 'vitest';
import {
  chatResponseToResponses,
  chatSseToResponsesSse,
  formatSseEvent,
  responsesRequestToChat
} from '../electron/main/translate';

describe('responsesRequestToChat', () => {
  it('translates string input into a single user message', () => {
    const chat = responsesRequestToChat({ model: 'm', input: 'hello' });
    expect(chat.model).toBe('m');
    expect(chat.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('translates instructions into a leading system message', () => {
    const chat = responsesRequestToChat({ model: 'm', input: 'hi', instructions: 'be brief' });
    expect((chat.messages as Array<{ role: string }>)[0]).toEqual({ role: 'system', content: 'be brief' });
  });

  it('translates input items with content parts including images', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'low' }
          ]
        }
      ]
    });
    const messages = chat.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'low' } }
    ]);
  });

  it('translates function_call and function_call_output items into chat assistant + tool messages', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'sum', arguments: '{"a":1,"b":2}' },
        { type: 'function_call_output', call_id: 'c1', output: '3' }
      ]
    });
    const messages = chat.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'sum', arguments: '{"a":1,"b":2}' } }]
    });
    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '3' });
  });

  it('rewraps flat function tools into chat function-nested form', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: 'x',
      tools: [{ type: 'function', name: 'add', description: 'd', parameters: { type: 'object' }, strict: true }]
    });
    expect(chat.tools).toEqual([
      { type: 'function', function: { name: 'add', description: 'd', parameters: { type: 'object' }, strict: true } }
    ]);
  });

  it('drops Responses-only tool types that Chat Completions cannot accept', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: 'x',
      tools: [
        { type: 'local_shell' },
        { type: 'web_search_preview' },
        { type: 'function', name: 'keep', parameters: { type: 'object' } }
      ]
    });
    expect(chat.tools).toEqual([
      { type: 'function', function: { name: 'keep', parameters: { type: 'object' } } }
    ]);
  });

  it('normalizes tool_choice: only forwards "none"/"auto"/"required" or a function selector', () => {
    expect(responsesRequestToChat({ model: 'm', input: 'x', tool_choice: 'auto' }).tool_choice).toBe('auto');
    expect(responsesRequestToChat({ model: 'm', input: 'x', tool_choice: 'required' }).tool_choice).toBe('required');
    expect(responsesRequestToChat({ model: 'm', input: 'x', tool_choice: { type: 'function', name: 'do' } }).tool_choice).toEqual({
      type: 'function',
      function: { name: 'do' }
    });
    expect(responsesRequestToChat({ model: 'm', input: 'x', tool_choice: { type: 'local_shell' } }).tool_choice).toBeUndefined();
  });

  it('maps max_output_tokens to max_tokens and reasoning.effort to reasoning_effort', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: 'x',
      max_output_tokens: 256,
      reasoning: { effort: 'high' }
    });
    expect(chat.max_tokens).toBe(256);
    expect(chat.reasoning_effort).toBe('high');
  });
});

describe('chatResponseToResponses', () => {
  it('translates a plain text chat completion into a Responses message item', () => {
    const out = chatResponseToResponses({
      id: 'r1',
      created: 100,
      model: 'm',
      choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    });
    expect(out.id).toBe('r1');
    expect(out.created_at).toBe(100);
    expect(out.model).toBe('m');
    expect(out.status).toBe('completed');
    const output = out.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: 'message', role: 'assistant' });
    expect((output[0].content as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'output_text',
      text: 'hi there',
      annotations: []
    });
    expect(out.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 2,
      total_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    });
  });

  it('maps finish_reason length to status incomplete with reason', () => {
    const out = chatResponseToResponses({
      choices: [{ message: { role: 'assistant', content: 'truncated' }, finish_reason: 'length' }]
    });
    expect(out.status).toBe('incomplete');
    expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('emits function_call items for tool_calls and reasoning item for reasoning_content', () => {
    const out = chatResponseToResponses({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'thinking...',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }
            ]
          }
        }
      ]
    });
    const output = out.output as Array<Record<string, unknown>>;
    const types = output.map((item) => item.type);
    expect(types).toContain('reasoning');
    expect(types).toContain('function_call');
    const fc = output.find((item) => item.type === 'function_call');
    expect(fc).toMatchObject({ call_id: 'call_1', name: 'lookup', arguments: '{"q":1}' });
  });
});

async function* asAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function collect(gen: AsyncGenerator<{ event: string; data: string }>): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = [];
  for await (const evt of gen) out.push(evt);
  return out;
}

describe('chatSseToResponsesSse', () => {
  it('emits Responses events for a streaming text completion', async () => {
    const chunks = [
      `data: {"id":"r1","model":"m","created":1,"choices":[{"delta":{"content":"hel"}}]}\n`,
      `data: {"id":"r1","model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n`,
      `data: [DONE]\n`
    ];
    const events = await collect(chatSseToResponsesSse(asAsync(chunks), { model: 'm' }));
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('response.created');
    expect(types[1]).toBe('response.in_progress');
    expect(types).toContain('response.output_item.added');
    expect(types.filter((t) => t === 'response.output_text.delta')).toHaveLength(2);
    expect(types).toContain('response.output_text.done');
    expect(types).toContain('response.output_item.done');
    expect(types.at(-2)).toBe('response.completed');
    expect(events.at(-1)).toEqual({ event: 'done', data: '[DONE]' });

    // Every non-terminal event carries response_id, event_id, sequence_number.
    let lastSeq = -1;
    for (const evt of events) {
      if (evt.event === 'done') continue;
      const parsed = JSON.parse(evt.data);
      expect(parsed.response_id).toBe('r1');
      expect(parsed.event_id).toMatch(/^evt_/);
      expect(parsed.sequence_number).toBeGreaterThan(lastSeq);
      lastSeq = parsed.sequence_number;
    }

    const completed = JSON.parse(events.at(-2)!.data);
    expect(completed.response.status).toBe('completed');
    expect(completed.response.output).toHaveLength(1);
    expect(completed.response.output[0].content[0].text).toBe('hello');
  });

  it('emits function_call streaming events for tool_calls deltas', async () => {
    const chunks = [
      `data: {"id":"r1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"do","arguments":"{\\"a\\""}}]}}]}\n`,
      `data: {"id":"r1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n`,
      `data: [DONE]\n`
    ];
    const events = await collect(chatSseToResponsesSse(asAsync(chunks), { model: 'm' }));
    const argsDeltas = events.filter((e) => e.event === 'response.function_call_arguments.delta');
    expect(argsDeltas).toHaveLength(2);
    const done = events.find((e) => e.event === 'response.function_call_arguments.done');
    expect(done).toBeDefined();
    const doneData = JSON.parse(done!.data);
    expect(doneData.arguments).toBe('{"a":1}');
  });

  it('formatSseEvent emits an SSE-compatible string', () => {
    const txt = formatSseEvent({ event: 'foo', data: '{"x":1}' });
    expect(txt).toBe('event: foo\ndata: {"x":1}\n\n');
  });
});
