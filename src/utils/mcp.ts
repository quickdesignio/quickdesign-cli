/**
 * Call one tool on the BFF's public MCP endpoint (POST /api/mcp) as a plain
 * JSON-RPC `tools/call`, without an `initialize` handshake. Goes through
 * `request(...)` so it carries the same bearer, session renewal and version
 * headers as every other command. The reply is SSE or plain JSON; both work.
 */
import { ApiError, request } from '../client.js';
import { parseSse } from './sse.js';

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError: boolean;
}

export const UNAVAILABLE_MESSAGE = "Live video-editor editing isn't available on this QuickDesign server.";

interface JsonRpcMessage {
  id?: number | string | null;
  result?: { content?: McpContent[]; isError?: boolean };
  error?: { code?: number; message?: string };
}

let nextId = 1;

const UNKNOWN_TOOL = /\b(not found|unknown tool|no such tool)\b/i;

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<McpToolResult> {
  const id = nextId++;
  let res: Response;
  try {
    res = await request<Response>('/api/mcp', {
      method: 'POST',
      raw: true,
      headers: { Accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 75_000),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const detail = typeof err.body === 'string' && err.body ? ` ${err.body.slice(0, 300)}` : '';
      throw new Error(err.status === 401 || err.status === 403 ? err.message : `${err.message}${detail}`);
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`The editor did not answer within ${Math.round((opts.timeoutMs ?? 75_000) / 1000)}s.`);
    }
    throw err;
  }

  const messages: JsonRpcMessage[] = [];
  const type = res.headers.get('content-type') ?? '';
  try {
    if (type.includes('text/event-stream')) {
      for await (const frame of parseSse<JsonRpcMessage>(res.body)) {
        if (frame.data && typeof frame.data === 'object') messages.push(frame.data);
      }
    } else {
      const parsed = JSON.parse(await res.text()) as JsonRpcMessage | JsonRpcMessage[];
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`The editor did not answer within ${Math.round((opts.timeoutMs ?? 75_000) / 1000)}s.`);
    }
    throw new Error('Unexpected reply from the QuickDesign MCP endpoint.');
  }

  const msg = messages.find((m) => m.id === id);
  if (!msg) throw new Error('The QuickDesign MCP endpoint sent no answer for this call.');
  if (msg.error) {
    const text = msg.error.message ?? 'MCP error';
    throw new Error(UNKNOWN_TOOL.test(text) ? UNAVAILABLE_MESSAGE : text);
  }
  const content = Array.isArray(msg.result?.content) ? msg.result!.content! : [];
  const isError = msg.result?.isError === true;
  if (isError && content.length === 1 && content[0].type === 'text' && /^(MCP error -?\d+: )?Tool \S+ not found/i.test(content[0].text)) {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
  return { content, isError };
}

/** The timeout (ms) for one `quickdesign_editor_call`: transcribing waits for the transcriber. */
export function editorCallTimeoutMs(tool: string): number {
  return tool === 'transcribe_clip' ? 200_000 : 75_000;
}
