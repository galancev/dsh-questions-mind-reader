/**
 * dsh-mind-questions — Client half.
 *
 * Renders bubbles in the root `shell.overlay` slot, right-aligned above the
 * composer. The Host owns detection and state; this module polls the loopback
 * route, shows one answer editor at a time, and posts the answer back.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mind-questions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'mindQuestions'
    const PREFIX = '/dsh-mq'
    const MAX_TEXT = 2000

    const DICT = {
      ru: {
        hint: 'Клик — ответить · правый клик — весь текст',
        translatedHint: 'Перевод · правый клик — оригинал',
        originalHint: 'Оригинал · правый клик — перевод',
        close: 'Скрыть',
        placeholder: 'Ответ на этот вопрос',
        send: 'Отправить',
        skip: 'Мимо',
        sending: 'Отправка…',
        proceeded: 'Модель пошла дальше · можно ответить',
        solved: 'Модель решила сама',
        answered: 'Отправлено · уйдёт на границе шага',
        marked: 'Модель пометила сама',
        offline: 'Нет связи',
        failed: 'Не отправлено',
        already: 'Уже отвечено',
        tooLong: 'Слишком длинный ответ',
      },
      en: {
        hint: 'Click to answer · right-click for the full text',
        translatedHint: 'Translated · right-click for the original',
        originalHint: 'Original · right-click for the translation',
        close: 'Dismiss',
        placeholder: 'Your answer to this question',
        send: 'Send',
        skip: 'Skip',
        sending: 'Sending…',
        proceeded: 'Model moved on · still answerable',
        solved: 'Model resolved it',
        answered: 'Sent · arrives at the next step',
        marked: 'Marked by the model',
        offline: 'No connection',
        failed: 'Not sent',
        already: 'Already answered',
        tooLong: 'Answer is too long',
      },
    }

    /** The Session currently displayed in the main view, if any. */
    function pickActiveSession(snapshot) {
      if (!snapshot || !snapshot.byId) return undefined
      for (const row of Object.values(snapshot.byId)) {
        if (row && ((row.retainedBy && row.retainedBy.mainView) || 0) > 0) return row.id
      }
      return undefined
    }

    /**
     * The scrolling message surface. It is the narrowest stable host element
     * that covers the conversation and nothing else: tabs, header, sidebar,
     * frame and right panel keep their geometry.
     */
    function chatSurface() {
      return document.querySelector('[data-conversation-scroll]')
    }

    const CSS = `
.dshmq-root{position:fixed;right:12px;bottom:220px;z-index:1;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;}
.dshmq-bubble{position:relative;pointer-events:auto;box-sizing:border-box;max-width:280px;min-width:120px;padding:9px 26px 10px 13px;border-radius:15px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px var(--dsw-alias-bg-mask-1);cursor:pointer;font-family:inherit;font-size:var(--dsh-content-font-size, 14px);line-height:1.6;animation:dshmq-in .18s ease-out;transition:border-color .18s,opacity .3s;}
.dshmq-bubble:hover{border-color:var(--dsw-alias-border-l3);}
.dshmq-bubble::after{content:"";position:absolute;right:18px;bottom:-5px;width:9px;height:9px;background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);transform:rotate(45deg);border-bottom-right-radius:2px;}
.dshmq-bubble.dshmq-proceeded{opacity:.72;}
.dshmq-bubble.dshmq-solved{opacity:.55;border-style:dashed;}
.dshmq-text{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;white-space:pre-wrap;}
.dshmq-bubble.dshmq-full .dshmq-text{-webkit-line-clamp:unset;display:block;}
.dshmq-dot{display:inline-block;width:5px;height:5px;margin-right:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);vertical-align:2px;}
.dshmq-foot{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary);opacity:0;transition:opacity .16s;}
.dshmq-bubble:hover .dshmq-foot{opacity:1;}
.dshmq-close{position:absolute;top:5px;right:5px;width:18px;height:18px;line-height:1;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;cursor:pointer;opacity:0;transition:opacity .16s,background .16s;}
.dshmq-bubble:hover .dshmq-close{opacity:1;}
.dshmq-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dshmq-editor{pointer-events:auto;cursor:default;margin-top:7px;}
.dshmq-editor textarea{display:block;box-sizing:border-box;width:260px;max-width:64vw;min-height:44px;max-height:150px;resize:vertical;padding:6px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none;}
.dshmq-editor textarea:focus{border-color:var(--dsw-alias-state-business-primary);}
.dshmq-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:6px;}
.dshmq-btn{pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;}
.dshmq-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dshmq-btn.dshmq-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-on-color);}
.dshmq-btn:disabled{opacity:.6;cursor:default;}
.dshmq-error{margin-top:5px;font-size:11px;color:var(--dsw-alias-state-error-primary);}
@keyframes dshmq-in{from{opacity:0;transform:translateY(6px) scale(.97);}to{opacity:1;transform:none;}}
`

    const EMPTY = { enabled: true, maxBubbles: 3, ttlSec: 30, gutterPx: 300, running: false, questions: [] }

    function MindQuestions(props) {
      const { t, useActiveSessionId } = props
      const sessionId = useActiveSessionId()

      const [data, setData] = React.useState(EMPTY)
      const [hidden, setHidden] = React.useState(() => new Set())
      const [expanded, setExpanded] = React.useState(() => new Set())
      const [showOriginal, setShowOriginal] = React.useState(() => new Set())
      const [pausedUntil, setPausedUntil] = React.useState({})
      const [editorId, setEditorId] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [failure, setFailure] = React.useState({ id: null, text: '' })
      const [box, setBox] = React.useState({ right: 12, gutter: 0 })
      const [, tick] = React.useState(0)

      const editorRef = React.useRef(null)
      const delayRef = React.useRef(1500)

      // Reserve the right strip inside the chat column only: the frame, the
      // header, the sidebar and the right panel keep their geometry.
      React.useEffect(() => {
        let frame = 0
        let observed = null
        const observer = new ResizeObserver(() => schedule())

        function apply() {
          frame = 0
          const surface = chatSurface()
          if (surface && surface !== observed) {
            if (observed) observer.unobserve(observed)
            observer.observe(surface)
            observed = surface
          }
          if (!surface) return
          const rect = surface.getBoundingClientRect()
          const want = data.enabled === false ? 0 : Math.max(0, Number(data.gutterPx) || 0)
          let gutter = Math.min(want, Math.max(0, Math.round(rect.width) - 520))
          if (gutter < 160) gutter = 0
          if (surface.__dshmqGutter !== gutter) {
            surface.__dshmqGutter = gutter
            surface.style.paddingRight = gutter ? gutter + 'px' : ''
          }
          const nextRight = Math.max(8, Math.round(window.innerWidth - rect.right) + 12)
          setBox((prev) =>
            prev.right === nextRight && prev.gutter === gutter ? prev : { right: nextRight, gutter },
          )
        }

        function schedule() {
          if (frame) return
          frame = requestAnimationFrame(apply)
        }

        apply()
        window.addEventListener('resize', schedule)
        const timer = setInterval(schedule, 1000)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          clearInterval(timer)
          if (frame) cancelAnimationFrame(frame)
          if (observed) {
            observed.style.paddingRight = ''
            delete observed.__dshmqGutter
          }
        }
      }, [data.enabled, data.gutterPx])

      const visible = React.useMemo(() => {
        const now = Date.now()
        const ttlMs = Math.max(0, Number(data.ttlSec) || 0) * 1000
        return (data.questions || [])
          .filter((q) => !hidden.has(q.id))
          .filter((q) => {
            if (!ttlMs) return true
            if (editorId === q.id) return true
            const from = Math.max(q.ts || 0, pausedUntil[q.id] || 0)
            return now - from < ttlMs
          })
          .slice(-Math.max(1, Number(data.maxBubbles) || 3))
      }, [data, hidden, pausedUntil, editorId, tick])

      delayRef.current = data.running || visible.length > 0 ? 500 : 2000

      React.useEffect(() => {
        setData(EMPTY)
        setHidden(new Set())
        setExpanded(new Set())
        setPausedUntil({})
        setEditorId(null)
        setDraft('')
        if (!sessionId) return undefined
        let stopped = false
        let timer = 0

        async function poll() {
          try {
            const response = await fetch(
              PREFIX + '/state?session=' + encodeURIComponent(sessionId),
              { cache: 'no-store' },
            )
            if (!stopped && response.ok) {
              const next = await response.json()
              if (!stopped) setData(next)
            }
          } catch {
            /* transient: the next tick retries */
          }
          if (!stopped) timer = setTimeout(poll, delayRef.current)
        }

        poll()
        return () => {
          stopped = true
          clearTimeout(timer)
        }
      }, [sessionId])

      React.useEffect(() => {
        const id = setInterval(() => tick((n) => n + 1), 1000)
        return () => clearInterval(id)
      }, [])

      React.useEffect(() => {
        if (editorId && editorRef.current) editorRef.current.focus()
      }, [editorId])

      function hide(id) {
        setHidden((prev) => {
          const next = new Set(prev)
          next.add(id)
          return next
        })
      }

      function pause(id) {
        setPausedUntil((prev) => ({ ...prev, [id]: Date.now() }))
      }

      function openEditor(id) {
        setFailure({ id: null, text: '' })
        setEditorId(id)
        setDraft('')
        pause(id)
      }

      function closeEditor() {
        setEditorId(null)
        setDraft('')
        setFailure({ id: null, text: '' })
      }

      async function send(id) {
        const text = draft.trim()
        if (!text || sending) return
        if (text.length > MAX_TEXT) {
          setFailure({ id, text: t('tooLong') })
          return
        }
        setSending(true)
        setFailure({ id: null, text: '' })
        try {
          const response = await fetch(PREFIX + '/answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, text }),
          })
          const body = await response.json().catch(() => ({}))
          if (response.ok && body.ok) {
            hide(id)
            closeEditor()
            return
          }
          const code = String(body.error || response.status)
          setFailure({
            id,
            text: code === 'already-answered' ? t('already') : t('failed') + ': ' + code,
          })
        } catch {
          setFailure({ id, text: t('offline') })
        } finally {
          setSending(false)
        }
      }

      if (!sessionId || data.enabled === false || visible.length === 0) {
        return h('style', null, CSS)
      }

      const bubbleWidth = Math.max(200, Math.min(280, window.innerWidth - 120))

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CSS),
        h(
          'div',
          { className: 'dshmq-root', key: 'root', style: { right: box.right + 'px' } },
          visible.map((q) => {
            const isEditor = editorId === q.id
            const full = expanded.has(q.id) || isEditor
            const className = [
              'dshmq-bubble',
              q.status === 'proceeded' ? 'dshmq-proceeded' : '',
              q.status === 'solved' ? 'dshmq-solved' : '',
              full ? 'dshmq-full' : '',
            ]
              .filter(Boolean)
              .join(' ')

            const original = !!q.translated && showOriginal.has(q.id)
            const shown = q.translated && !original ? q.translated : q.text

            const foot =
              q.status === 'proceeded'
                ? t('proceeded')
                : q.status === 'solved'
                  ? t('solved')
                  : q.translated
                    ? original
                      ? t('originalHint')
                      : t('translatedHint')
                    : t('hint')

            return h(
              'div',
              {
                key: q.id,
                className,
                style: { maxWidth: bubbleWidth + 'px' },
                role: 'button',
                tabIndex: 0,
                title: q.origin === 'marker' ? t('marked') : undefined,
                onMouseEnter: () => pause(q.id),
                onMouseLeave: () => pause(q.id),
                onClick: () => {
                  if (isEditor) return
                  if (q.status === 'solved' || q.status === 'answered') {
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(q.id)) next.delete(q.id)
                      else next.add(q.id)
                      return next
                    })
                    return
                  }
                  openEditor(q.id)
                },
                onContextMenu: (event) => {
                  event.preventDefault()
                  if (q.translated) {
                    setShowOriginal((prev) => {
                      const next = new Set(prev)
                      if (next.has(q.id)) next.delete(q.id)
                      else next.add(q.id)
                      return next
                    })
                    return
                  }
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(q.id)) next.delete(q.id)
                    else next.add(q.id)
                    return next
                  })
                },
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshmq-close',
                  title: t('close'),
                  onClick: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    hide(q.id)
                  },
                },
                '×',
              ),
              h(
                'div',
                { className: 'dshmq-text' },
                q.origin === 'marker' ? h('span', { className: 'dshmq-dot', 'aria-hidden': true }) : null,
                shown,
              ),
              h('div', { className: 'dshmq-foot' }, foot),
              isEditor
                ? h(
                    'div',
                    {
                      className: 'dshmq-editor',
                      onClick: (event) => event.stopPropagation(),
                    },
                    h('textarea', {
                      ref: editorRef,
                      rows: 2,
                      value: draft,
                      placeholder: t('placeholder'),
                      onChange: (event) => setDraft(event.target.value),
                      onKeyDown: (event) => {
                        event.stopPropagation()
                        if (event.key === 'Escape') closeEditor()
                        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault()
                          send(q.id)
                        }
                      },
                    }),
                    h(
                      'div',
                      { className: 'dshmq-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshmq-btn',
                          onClick: () => closeEditor(),
                        },
                        t('skip'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshmq-btn dshmq-primary',
                          disabled: sending,
                          onClick: () => send(q.id),
                        },
                        sending ? t('sending') : t('send'),
                      ),
                    ),
                    failure.id === q.id
                      ? h('div', { className: 'dshmq-error' }, failure.text)
                      : null,
                  )
                : null,
            )
          }),
        ),
      )
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'mind-questions: dictionaries')
        const t = ctx.locale.bind(NS)
        const subscribeSessions = (notify) => ctx.sessions.list.subscribe(notify)
        const readActiveSession = () => pickActiveSession(ctx.sessions.list.getSnapshot())
        const useActiveSessionId = () => React.useSyncExternalStore(subscribeSessions, readActiveSession)

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'mind-questions', order: 20 },
            (props) => h(MindQuestions, { ...props, t, useActiveSessionId }),
          ),
        )
      },
    }
  },
})
