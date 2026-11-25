/**
 * dsh-mind-questions — Host half.
 *
 * Reads the live reasoning stream, keeps the questions the model is stuck on,
 * serves them to the Client module over two loopback routes, and steers the
 * answer back into the session at the next step boundary.
 *
 * It never edits the transcript, never stores anything on disk, and never
 * renders: bubbles belong to the Client slot `shell.overlay`.
 */

import { randomUUID } from 'node:crypto'
import {
  MarkerScanner,
  SentenceStream,
  isMeaningfulText,
  isQuestionText,
  langOf,
  looksLikeQuestion,
  normalize,
  similar,
  tidy,
} from './lib/detect.js'

const ROUTE_PREFIX = '/dsh-mq'

const DEFAULTS = {
  enabled: true,
  /** Ask the model to mark its own blocking questions in the reasoning. */
  markers: true,
  /** Regex fallback for reasoning the model does not mark. */
  heuristics: true,
  /** Bubbles shown at once. */
  maxBubbles: 3,
  /** Auto-hide delay; 0 keeps a bubble until it is answered or closed. */
  ttlSec: 60,
  /** Translate a detected question through ctx.translator before showing it. */
  translateQuestions: true,
  /** Target language for that translation. */
  targetLang: 'ru',
}

/** Marker contract injected as a system-prompt section. */
const PROMPT_TEXT = [
  '## Mind questions (dsh-mind-questions)',
  '',
  'While thinking, when you hit a genuine ambiguity that changes what you do next and only the user can settle it, write it inside your reasoning as:',
  '',
  '[[ask]]one short question, at most 20 words[[/ask]]',
  '',
  'If you later resolve it yourself, write [[done]]one-line resolution[[/done]].',
  '',
  'Only for real blocking ambiguity: never rhetorical self-checks, never something you can decide yourself. At most 3 per step. Write the markers only around the question itself — never quote, mention, or discuss them elsewhere in the reasoning. The user may answer from a bubble without interrupting you; if no answer comes, decide yourself and continue. Keep these markers out of your final answer, out of tool arguments, and out of code.',
].join('\n')

const MIN_GAP_MS = 1000
const STEP_ASK_LIMIT = 3
const STEP_HEURISTIC_LIMIT = 6
const DEDUPE_TTL_MS = 5 * 60 * 1000
const OPEN_KEEP_MS = 15 * 60 * 1000
const CLOSED_KEEP_MS = 60 * 1000

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const int = (value, fallback, lo, hi) => {
    const n = Math.round(Number(value))
    if (!Number.isFinite(n)) return fallback
    return n < lo ? lo : n > hi ? hi : n
  }
  return {
    enabled: src.enabled !== false,
    markers: src.markers !== false,
    heuristics: src.heuristics !== false,
    maxBubbles: int(src.maxBubbles, DEFAULTS.maxBubbles, 1, 9),
    ttlSec: int(src.ttlSec, DEFAULTS.ttlSec, 0, 600),
    translateQuestions: src.translateQuestions !== false,
    targetLang: typeof src.targetLang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(src.targetLang)
      ? src.targetLang
      : DEFAULTS.targetLang,
    promptOrder: int(src.promptOrder, 9500, 1, 20000),
  }
}

export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} rawConfig - bundle row config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  const sessions = new Map()
  /** @type {Map<string, {id: string, sessionId: string, text: string, ts: number, status: string, origin: string}>} */
  const questions = new Map()

  let budget = 20
  let budgetAt = Date.now()

  function sessionState(sessionId) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        questions: [],
        seen: new Map(),
        markers: new MarkerScanner(),
        sentences: new SentenceStream(),
        stepAsked: 0,
        stepHeuristic: 0,
        running: false,
        lastEmitAt: 0,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  function resetStep(state) {
    state.markers.reset()
    state.sentences.reset()
    state.stepAsked = 0
    state.stepHeuristic = 0
    const now = Date.now()
    for (const [key, at] of state.seen) if (now - at > DEDUPE_TTL_MS) state.seen.delete(key)
  }

  function markProceeded(sessionId) {
    const state = sessions.get(sessionId)
    if (!state || state.questions.length === 0) return
    for (const id of state.questions) {
      const q = questions.get(id)
      if (q && q.status === 'open') {
        q.status = 'proceeded'
      }
    }
    state.questions = []
  }

  function isDuplicate(state, text) {
    const key = normalize(text)
    if (!key || key.length < 3) return true
    for (const seen of state.seen.keys()) if (similar(seen, key)) return true
    state.seen.set(key, Date.now())
    return false
  }

  function emitQuestion(sessionId, text, origin) {
    const now = Date.now()
    const trimmed = tidy(text)
    if (!isMeaningfulText(trimmed)) return
    const state = sessionState(sessionId)
    // The gap damps heuristic bursts; a marked question is deliberate and
    // already bounded by STEP_ASK_LIMIT, so two of them may land together.
    if (origin !== 'marker' && now - state.lastEmitAt < MIN_GAP_MS) return
    if (now - budgetAt > 60000) {
      budgetAt = now
      budget = 20
    }
    if (budget <= 0) return
    budget--
    state.lastEmitAt = now

    const id = randomUUID()
    const question = {
      id,
      sessionId,
      text: tidy(text),
      ts: now,
      status: 'open',
      origin: origin || 'auto',
    }
    questions.set(id, question)
    state.questions.push(id)

    if (questions.size > 200) {
      for (const old of [...questions.keys()].slice(0, questions.size - 200)) questions.delete(old)
    }
    void translateQuestion(question)
  }

  /* ---------------- translation ---------------- */

  /** Question text -> translated text; bounded, and the service has its own cache. */
  const translations = new Map()
  let translating = 0

  async function translateQuestion(q) {
    if (!config.translateQuestions) return
    const lang = langOf(q.text)
    if (!lang || lang === config.targetLang) return
    const cached = translations.get(q.text)
    if (cached) {
      q.translated = cached
      return
    }
    const translator = ctx.get('translator')
    if (!translator || typeof translator.resolve !== 'function' || translating >= 3) return

    translating++
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 12000)
    try {
      const spec = translator.resolve({ text: q.text, targetLanguage: config.targetLang })
      const translated = String((await translator.translate(spec, abort.signal)) || '').trim()
      if (!translated || translated === q.text) return
      translations.set(q.text, translated)
      if (translations.size > 300) translations.delete(translations.keys().next().value)
      q.translated = translated
    } catch {
      /* best effort: an untranslated question is still a question */
    } finally {
      clearTimeout(timer)
      translating--
    }
  }

  function considerSentence(sessionId, raw) {
    const state = sessionState(sessionId)
    if (state.stepHeuristic >= STEP_HEURISTIC_LIMIT) return
    if (!looksLikeQuestion(raw)) return
    const text = tidy(raw)
    if (isDuplicate(state, text)) return
    state.stepHeuristic++
    emitQuestion(sessionId, text, 'auto')
  }

  function considerMarked(sessionId, text) {
    const state = sessionState(sessionId)
    if (state.stepAsked >= STEP_ASK_LIMIT) return
    if (!isQuestionText(text)) return
    if (isDuplicate(state, text)) return
    state.stepAsked++
    emitQuestion(sessionId, text, 'marker')
  }

  /** The model resolved a marked question itself. */
  function resolveMarked(sessionId, note) {
    const state = sessions.get(sessionId)
    if (!state) return
    for (let i = state.questions.length - 1; i >= 0; i--) {
      const q = questions.get(state.questions[i])
      if (!q || q.origin !== 'marker' || q.status !== 'open') continue
      q.status = 'solved'
      q.note = tidy(note, 160)
      state.questions.splice(i, 1)
      return
    }
  }

  function onReasoning(sessionId, delta) {
    const state = sessionState(sessionId)

    if (config.markers) {
      for (const marker of state.markers.push(delta)) {
        if (marker.kind === 'ask') considerMarked(sessionId, marker.text)
        else resolveMarked(sessionId, marker.text)
      }
    }
    if (config.heuristics) {
      for (const sentence of state.sentences.push(delta)) considerSentence(sessionId, sentence)
    }
  }

  /* ---------------- live sources ---------------- */

  ctx.effect(() =>
    ctx.on('agent/assistant-stream', ({ agent, frame } = {}) => {
      if (!config.enabled) return
      if (!agent || !frame) return
      const sessionId = String(agent.id || '')
      if (!sessionId) return
      const state = sessionState(sessionId)

      if (frame.type === 'start') {
        resetStep(state)
        return
      }
      if (frame.type === 'end') {
        markProceeded(sessionId)
        return
      }
      if (frame.type !== 'chunk') return
      const chunk = frame.chunk || {}
      if (chunk.type === 'reasoning-delta') {
        if (typeof chunk.text === 'string' && chunk.text) onReasoning(sessionId, chunk.text)
        return
      }
      if (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') {
        markProceeded(sessionId)
      }
    }),
  )

  ctx.effect(() =>
    ctx.on('agent/status', ({ agent, status } = {}) => {
      if (!agent) return
      const state = sessionState(String(agent.id || ''))
      state.running = status === 'running'
      if (state.running) resetStep(state)
    }),
  )

  /* ---------------- marker contract ---------------- */

  if (config.markers) {
    ctx.inject(['systemPrompt'], (scoped) => {
      scoped.effect(() =>
        scoped.systemPrompt.section({
          name: 'dsh-mind-questions',
          order: config.promptOrder,
          text: PROMPT_TEXT,
        }),
      )
    })
  }

  /* ---------------- loopback routes ---------------- */

  function rejectForeign(req, res) {
    const host = String(req.headers.host || '')
    const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
    const loopback =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '::1' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    const crossSite = String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site'
    const origin = req.headers.origin
    let foreignOrigin = false
    if (origin && origin !== 'null') {
      try {
        foreignOrigin = new URL(origin).host !== host
      } catch {
        foreignOrigin = true
      }
    }
    if (loopback && !crossSite && !foreignOrigin) return false
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return true
  }

  function sendJson(res, code, body) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  function readJson(req, limit = 8192) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          req.destroy()
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }

  function visible(sessionId) {
    const now = Date.now()
    const list = []
    for (const q of questions.values()) {
      if (q.sessionId !== sessionId) continue
      const age = now - q.ts
      if (q.status === 'open' || q.status === 'proceeded') {
        if (age > OPEN_KEEP_MS) continue
      } else if (age > CLOSED_KEEP_MS) {
        continue
      }
      list.push({
        id: q.id,
        text: q.text,
        translated: q.translated,
        ts: q.ts,
        status: q.status,
        origin: q.origin,
        note: q.note,
      })
    }
    return list
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PREFIX + '/state',
      handler: (req, res) => {
        if (rejectForeign(req, res)) return
        let sessionId = ''
        try {
          sessionId = new URL(String(req.url || '/'), 'http://localhost').searchParams.get('session') || ''
        } catch {
          sessionId = ''
        }
        const state = sessions.get(sessionId)
        sendJson(res, 200, {
          enabled: config.enabled,
          markers: config.markers,
          heuristics: config.heuristics,
          maxBubbles: config.maxBubbles,
          ttlSec: config.ttlSec,
          running: !!state?.running,
          questions: config.enabled && sessionId ? visible(sessionId) : [],
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PREFIX + '/debug',
      handler: (req, res) => {
        if (rejectForeign(req, res)) return
        const rows = [...sessions.entries()].map(([sessionId, state]) => ({
          sessionId,
          running: state.running,
          questions: [...questions.values()]
            .filter((q) => q.sessionId === sessionId)
            .map((q) => ({
              id: q.id,
              text: q.text,
              translated: q.translated,
              origin: q.origin,
              status: q.status,
              ts: q.ts,
            })),
        }))
        sendJson(res, 200, { enabled: config.enabled, sessions: rows })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PREFIX + '/answer',
      handler: async (req, res) => {
        if (rejectForeign(req, res)) return
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' })
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { ok: false, error: 'bad-json' })
        const id = String(body.id || '')
        const text = String(body.text || '').trim()
        if (!id || !text) return sendJson(res, 400, { ok: false, error: 'missing' })
        if (text.length > 2000) return sendJson(res, 400, { ok: false, error: 'too-long' })

        const q = questions.get(id)
        if (!q) return sendJson(res, 404, { ok: false, error: 'no-such-question' })
        if (q.status === 'answered') return sendJson(res, 409, { ok: false, error: 'already-answered' })

        const controller = ctx.get('sessionController')
        if (!controller || typeof controller.prompt !== 'function') {
          return sendJson(res, 503, { ok: false, error: 'no-session-controller' })
        }

        const prefix =
          langOf(q.text) === 'ru'
            ? `Ответ на вопрос, который ты не задал: «${q.text.slice(0, 200)}» — `
            : `An answer to a question you left unasked: "${q.text.slice(0, 200)}" — `

        try {
          const abort = new AbortController()
          await controller.prompt(
            {
              requestId: randomUUID(),
              sessionId: q.sessionId,
              mode: 'steer',
              content: [{ type: 'text', text: prefix + text }],
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            abort.signal,
          )
        } catch (error) {
          return sendJson(res, 502, { ok: false, error: String(error?.message || error) })
        }

        q.status = 'answered'
        return sendJson(res, 200, { ok: true })
      },
    }),
  )

  /* ---------------- lifecycle ---------------- */

  ctx.effect(() => () => {
    sessions.clear()
    questions.clear()
  })
}
