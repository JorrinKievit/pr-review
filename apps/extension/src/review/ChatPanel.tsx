import type { Decision, PrRef } from '@pr-review/domain'
import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../components/ui/input-group.tsx'
import { Message, MessageContent } from '../components/ui/message.tsx'
import { MessageScroller, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '../components/ui/message-scroller.tsx'
import { Kbd, Spinner } from '../ui/index.tsx'
import { useConversation } from './conversation.ts'

/** Questions about the whole decision; the companion resumes one Claude session per decision. */
export function ChatPanel(props: { prRef: PrRef; headSha: string; decision: Decision; focus: number }) {
  const { turns, busy, failed, send: ask } = useConversation(props.prRef, props.headSha, { _tag: 'Decision', decision: props.decision })
  const [question, setQuestion] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => input.current?.focus(), [props.focus])

  const send = () => {
    if (ask(question)) setQuestion('')
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 text-xs text-dim">
        About this decision <Kbd>⌘J</Kbd>
      </div>
      <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="flex flex-col gap-3 px-3 pb-3">
            {turns.length === 0 && <p className="text-sm text-muted-foreground">Ask why it was done this way, where else it is used, or whether something like it already exists.</p>}
            {turns.map((t, i) => {
              const text = t.answer
              return (
                <div key={i} className="flex flex-col gap-2">
                  <Message align="end">
                    <MessageContent className="rounded-lg border border-border px-2.5 py-1.5 text-foreground">{t.question}</MessageContent>
                  </Message>
                  <Message>
                    <MessageContent className="rounded-lg bg-accent px-2.5 py-1.5 text-muted-foreground">
                      {text ? <Streamdown className="text-sm">{text}</Streamdown> : <Spinner className="size-3" />}
                    </MessageContent>
                  </Message>
                </div>
              )
            })}
            {failed && <p className="text-sm text-destructive">Claude could not answer. Ask again.</p>}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
      </MessageScrollerProvider>
      <InputGroup className="m-3 w-auto">
        <InputGroupTextarea
          ref={input}
          aria-label="Ask about this decision"
          rows={2}
          value={question}
          placeholder="Ask about this decision…"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton size="xs" variant="default" className="ml-auto" disabled={busy || !question.trim()} onClick={send}>
            Ask
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </aside>
  )
}
