/**
 * Chrome native messaging frames: a 4-byte little-endian length, then UTF-8 JSON.
 * We only ever send JSON strings (chunks of the ndjson RPC stream).
 */

// Chrome rejects host messages over 1 MB. A JSON-escaped char takes at most 6 bytes.
export const MAX_MESSAGE_CHARS = 150_000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeFrame(message: string): Uint8Array {
  const body = encoder.encode(JSON.stringify(message))
  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length, true)
  frame.set(body, 4)
  return frame
}

/** Splits a chunk of the text stream into messages small enough for one frame; joining them restores it. */
export function splitMessage(message: string, max = MAX_MESSAGE_CHARS): string[] {
  if (message.length <= max) return [message]
  const parts: string[] = []
  for (let i = 0; i < message.length; i += max) parts.push(message.slice(i, i + max))
  return parts
}

export class FrameDecoder {
  private buffer = new Uint8Array(0)

  push(chunk: Uint8Array): string[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length)
    joined.set(this.buffer)
    joined.set(chunk, this.buffer.length)
    const messages: string[] = []
    let offset = 0
    while (joined.length - offset >= 4) {
      const size = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint32(0, true)
      if (joined.length - offset - 4 < size) break
      const value: unknown = JSON.parse(decoder.decode(joined.subarray(offset + 4, offset + 4 + size)))
      messages.push(typeof value === 'string' ? value : JSON.stringify(value))
      offset += 4 + size
    }
    this.buffer = joined.slice(offset)
    return messages
  }
}
