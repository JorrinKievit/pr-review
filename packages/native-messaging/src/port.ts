/** The subset of `chrome.runtime.Port` the transport uses. */
export interface PortLike {
  postMessage(message: unknown): void
  readonly onMessage: { addListener(f: (message: unknown) => void): void }
  readonly onDisconnect: { addListener(f: () => void): void }
  disconnect(): void
}

/** The subset of `chrome.runtime.onConnect` the transport uses. */
export interface OnConnectLike {
  addListener(f: (port: PortLike) => void): void
}

const pair = (): [PortLike, PortLike] => {
  const listeners = [new Set<(m: unknown) => void>(), new Set<(m: unknown) => void>()]
  const disconnects = [new Set<() => void>(), new Set<() => void>()]
  let open = true
  const side = (me: 0 | 1): PortLike => {
    const other = me === 0 ? 1 : 0
    return {
      postMessage: (m) => {
        if (!open) throw new Error('Attempting to use a disconnected port object')
        // Chrome delivers asynchronously and serializes the payload.
        const copy = structuredClone(m)
        queueMicrotask(() => open && listeners[other]!.forEach((f) => f(copy)))
      },
      onMessage: { addListener: (f) => void listeners[me]!.add(f) },
      onDisconnect: { addListener: (f) => void disconnects[me]!.add(f) },
      disconnect: () => {
        if (!open) return
        open = false
        queueMicrotask(() => disconnects[other]!.forEach((f) => f()))
      },
    }
  }
  return [side(0), side(1)]
}

/** In-memory stand-in for `chrome.runtime.connect` / `onConnect`, for tests. */
export function memoryHub() {
  const handlers = new Set<(p: PortLike) => void>()
  const ports: PortLike[] = []
  return {
    onConnect: { addListener: (f) => void handlers.add(f) } satisfies OnConnectLike,
    connect(): PortLike {
      const [client, server] = pair()
      ports.push(server)
      queueMicrotask(() => handlers.forEach((f) => f(server)))
      return client
    },
    /** The far end goes away (host crash, worker restart): every client sees onDisconnect. */
    disconnectAll() {
      for (const p of ports) p.disconnect()
    },
  }
}
