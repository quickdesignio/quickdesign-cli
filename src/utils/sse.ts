/**
 * Server-Sent Events parser. Node's fetch doesn't ship an EventSource, so we
 * roll a small one over the response body: read bytes, split on blank lines
 * (the SSE frame boundary), and hand back one decoded `{ event, data }` per
 * frame. Heartbeat / comment lines (`:keep-alive`) are ignored.
 *
 * Used by `quickdesign brand dna` — the only SSE endpoint the CLI currently
 * consumes. Keep this generic so future streaming endpoints (Claude agent
 * responses, etc.) can reuse it.
 */
import { Readable } from 'node:stream';

export interface SseFrame<T = unknown> {
  /** The SSE event name (from `event: <name>`). Defaults to 'message' per spec. */
  event: string;
  /** Parsed JSON payload if the `data:` line(s) were valid JSON, else the raw string. */
  data: T;
  /** The raw concatenated `data:` lines, in case the caller needs it untouched. */
  raw: string;
}

export async function* parseSse<T = unknown>(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<SseFrame<T>> {
  if (!body) return;
  const nodeStream = Readable.fromWeb(body as import('stream/web').ReadableStream);
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of nodeStream) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });

    // SSE frames are terminated by a blank line. Normalize CRLF → LF first.
    buffer = buffer.replace(/\r\n/g, '\n');

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const parsed = parseFrame<T>(frame);
      if (parsed) yield parsed;
    }
  }

  // Flush any trailing frame without a closing blank line.
  if (buffer.trim()) {
    const parsed = parseFrame<T>(buffer);
    if (parsed) yield parsed;
  }
}

function parseFrame<T>(frame: string): SseFrame<T> | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;      // heartbeat / comment
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    // Per spec: a single leading space after the colon is stripped.
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // id / retry fields: ignored; we don't need reconnection support.
  }

  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data: T;
  try {
    data = JSON.parse(raw) as T;
  } catch {
    data = raw as unknown as T;
  }
  return { event, data, raw };
}
