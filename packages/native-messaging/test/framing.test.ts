import { assert, describe, it } from '@effect/vitest'
import { FrameDecoder, MAX_MESSAGE_CHARS, encodeFrame, splitMessage } from '../src/framing.ts'

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) out.set(p, (o += p.length) - p.length)
  return out
}

describe('native messaging framing', () => {
  it('round-trips one frame', () => {
    const frame = encodeFrame('{"a":"héllo"}\n')
    assert.strictEqual(new DataView(frame.buffer).getUint32(0, true), frame.length - 4)
    assert.deepStrictEqual(new FrameDecoder().push(frame), ['{"a":"héllo"}\n'])
  })

  it('decodes a frame split across reads', () => {
    const frame = encodeFrame('split me')
    const d = new FrameDecoder()
    assert.deepStrictEqual(d.push(frame.subarray(0, 2)), [])
    assert.deepStrictEqual(d.push(frame.subarray(2, 7)), [])
    assert.deepStrictEqual(d.push(frame.subarray(7)), ['split me'])
  })

  it('decodes two frames in one read', () => {
    assert.deepStrictEqual(new FrameDecoder().push(concat([encodeFrame('one'), encodeFrame('two')])), ['one', 'two'])
  })

  it('splits a 3 MB message into frames under 1 MB that join back', () => {
    const big = `${'x'.repeat(3_000_000)}é\n`
    const parts = splitMessage(big)
    assert.isTrue(parts.length >= 4)
    for (const p of parts) assert.isBelow(encodeFrame(p).length, 1024 * 1024)
    assert.strictEqual(parts.join(''), big)
    assert.isBelow(MAX_MESSAGE_CHARS, 1024 * 1024)
  })

  it('leaves a short message whole', () => {
    assert.deepStrictEqual(splitMessage('short\n'), ['short\n'])
  })
})
