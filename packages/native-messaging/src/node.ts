import type { Readable, Writable } from 'node:stream'
import { FrameDecoder, encodeFrame } from './framing.ts'
import type { OnConnectLike, PortLike } from './port.ts'

/** A port over Node streams speaking Chrome's native messaging framing (the host side uses stdin/stdout). */
export function streamPort(input: Readable, output: Writable): PortLike {
  const decoder = new FrameDecoder()
  const messageListeners = new Set<(m: unknown) => void>()
  const disconnectListeners = new Set<() => void>()
  let open = true
  const close = () => {
    if (!open) return
    open = false
    disconnectListeners.forEach((f) => f())
  }
  input.on('data', (chunk: Buffer) => {
    for (const m of decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) messageListeners.forEach((f) => f(m))
  })
  input.on('end', close)
  input.on('close', close)
  return {
    postMessage: (m) => void output.write(encodeFrame(typeof m === 'string' ? m : JSON.stringify(m))),
    onMessage: { addListener: (f) => void messageListeners.add(f) },
    onDisconnect: { addListener: (f) => void disconnectListeners.add(f) },
    disconnect: () => {
      open = false
      output.end()
    },
  }
}

/** An `onConnect` that delivers exactly one already-open port (the host has a single stdio connection). */
export const singlePort = (port: PortLike): OnConnectLike => ({
  addListener: (f) => queueMicrotask(() => f(port)),
})
