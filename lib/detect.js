/**
 * Question detection for dsh-mind-questions.
 *
 * Two independent sources feed one answer: the marker protocol the model is
 * asked to follow inside its reasoning, and heuristics over reasoning prose.
 * Everything here is pure and synchronous so it can be tested without DSH.
 */

/** Marker pair the model is asked to write around a real blocking question. */
export const MARKER_ASK_OPEN = '[[ask]]'
export const MARKER_ASK_CLOSE = '[[/ask]]'
/** Marker pair for a question the model resolved on its own. */
export const MARKER_DONE_OPEN = '[[done]]'
export const MARKER_DONE_CLOSE = '[[/done]]'

const ASK_RE = /\[\[ask\]\]([\s\S]{1,400}?)\[\[\/ask\]\]/g
const DONE_RE = /\[\[done\]\]([\s\S]{1,400}?)\[\[\/done\]\]/g

const MD_PREFIX = /^[-*+>\s]*(?:\d+[.、)]\s*)?/
const WRAP_HEAD = /^["'`«»“”„(（【[]+/
const WRAP_TAIL = /["'`«»“”„)）】\]]+$/
const STOP_PREFIX =
  /^(ну[,\s]+|так[,\s]+|хм+[,\s]*|итак[,\s]+|значит[,\s]+|ладно[,\s]+|окей[,\s]+|okay[,\s]+|well[,\s]+|so[,\s]+|hmm+[,\s]*)+/i

/** Text worth showing: at least two letters or digits, not just punctuation. */
export function isMeaningfulText(text) {
  return (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length >= 2
}

/** Trim one candidate to the text a bubble shows. */
export function tidy(text, limit = 160) {
  let t = String(text || '').replace(/\s+/g, ' ').trim()
  t = t.replace(MD_PREFIX, '').replace(STOP_PREFIX, '')
  t = t.replace(WRAP_HEAD, '').replace(WRAP_TAIL, '').trim()
  return t.slice(0, limit)
}

/**
 * Text inside one marker pair.
 *
 * A reasoning stream often names a marker before using it ("I will write
 * [[ask]] like this"), and the lazy capture then spans from that mention to
 * the real closing marker. Keep only what follows the last opener, and only
 * its first line.
 */
function markerText(raw) {
  let text = String(raw || '')
  const askAt = text.lastIndexOf(MARKER_ASK_OPEN)
  const doneAt = text.lastIndexOf(MARKER_DONE_OPEN)
  if (askAt >= 0 || doneAt >= 0) {
    const at = Math.max(askAt, doneAt)
    const opener = at === askAt ? MARKER_ASK_OPEN : MARKER_DONE_OPEN
    text = text.slice(at + opener.length)
  }
  text = text.split('\n')[0]
  text = text.replace(/\\/g, '').replace(/[`*_]/g, '')
  return tidy(text)
}

/** A marked question must read as a question, not as prose or code about markers. */
export function isQuestionText(text) {
  const t = String(text || '').trim()
  if (t.length < 6 || t.length > 240) return false
  if (/[`\\]|\[\[|\]\]/.test(t)) return false
  return /[?？]/.test(t)
}

/**
 * Incremental reader for `[[ask]]…[[/ask]]` and `[[done]]…[[/done]]`.
 *
 * Reasoning arrives as deltas, so a marker pair may be split across frames.
 * The scanner keeps a bounded buffer and a watermark, and returns every pair
 * that closed since the previous call.
 */
export class MarkerScanner {
  constructor(maxBytes = 6000) {
    this.maxBytes = maxBytes
    this.buf = ''
    this.pos = 0
  }

  /**
   * @param {string} delta - reasoning text appended since the previous call.
   * @returns {{kind: 'ask' | 'done', text: string}[]} completed markers, in order.
   */
  push(delta) {
    this.buf += String(delta || '')
    const events = []
    let last = 0
    for (const [re, kind] of [
      [ASK_RE, 'ask'],
      [DONE_RE, 'done'],
    ]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(this.buf))) {
        last = Math.max(last, re.lastIndex)
        if (m.index < this.pos) continue
        const text = markerText(m[1])
        if (!text) continue
        events.push({ kind, text, at: m.index })
      }
    }
    events.sort((a, b) => a.at - b.at)
    if (last > this.pos) this.pos = last
    this.trim()
    return events.map(({ kind, text }) => ({ kind, text }))
  }

  trim() {
    const keepFrom = Math.max(0, Math.min(this.pos, this.buf.length) - 2000)
    const drop = this.pos - 2000
    if (this.pos > 2000 && drop > 0) {
      this.buf = this.buf.slice(drop)
      this.pos -= drop
    } else if (this.buf.length > this.maxBytes) {
      const cut = this.buf.length - this.maxBytes
      this.buf = this.buf.slice(cut)
      this.pos = Math.max(0, this.pos - cut)
    }
    if (keepFrom < 0) this.pos = 0
  }

  reset() {
    this.buf = ''
    this.pos = 0
  }
}

/**
 * Split a reasoning delta stream into finished sentences, skipping fenced code.
 *
 * A trailing fragment that already ends with a question mark is yielded too:
 * waiting for the next `。` would delay the bubble past the interesting moment.
 */
export class SentenceStream {
  constructor(maxBytes = 8000) {
    this.maxBytes = maxBytes
    this.carry = ''
    this.fence = 0
  }

  /**
   * @param {string} delta - reasoning text appended since the previous call.
   * @returns {string[]} candidate sentences, trimmed.
   */
  push(delta) {
    const text = String(delta || '')
    const out = []
    let i = 0
    for (;;) {
      const at = text.indexOf('```', i)
      if (at < 0) {
        if (this.fence === 0) out.push(...this.takeSentences(text.slice(i)))
        break
      }
      if (this.fence === 0) out.push(...this.takeSentences(text.slice(i, at)))
      this.fence = this.fence === 0 ? 1 : 0
      i = at + 3
    }

    if (this.fence === 0) {
      const tail = this.carry.trim()
      if (tail.length >= 6 && /[？?]$/.test(tail)) {
        out.push(tail)
        this.carry = ''
      }
    }
    if (this.carry.length > this.maxBytes) this.carry = this.carry.slice(-2000)
    return out.map((s) => s.trim()).filter(Boolean)
  }

  takeSentences(chunk) {
    if (!chunk) return []
    this.carry += chunk
    const out = []
    const re = /[^。！？!?；;\n]*[。！？!?；;\n]/g
    let last = 0
    let m
    while ((m = re.exec(this.carry))) {
      out.push(m[0])
      last = re.lastIndex
    }
    this.carry = this.carry.slice(last)
    return out
  }

  reset() {
    this.carry = ''
    this.fence = 0
  }
}

/* ------------------------------------------------------------------ */
/* Language and question shape                                         */
/* ------------------------------------------------------------------ */

const SCRIPT_RE = {
  han: /[\u3400-\u9fff]/g,
  kana: /[\u3040-\u30ff]/g,
  hangul: /[\uac00-\ud7af\u1100-\u11ff]/g,
  cyr: /[\u0400-\u04ff]/g,
  lat: /[A-Za-z]/g,
}

/** Count characters per writing system. */
export function scriptCounts(text) {
  const t = String(text || '')
  const out = {}
  for (const k of Object.keys(SCRIPT_RE)) out[k] = (t.match(SCRIPT_RE[k]) || []).length
  return out
}

/** Writing system of one sentence, or null when nothing dominates. */
export function langOf(text) {
  const c = scriptCounts(text)
  if (c.kana > 0) return 'ja'
  if (c.hangul > 0) return 'ko'
  if (c.cyr >= 3 && c.cyr > c.lat) return 'ru'
  if (c.han >= 2 && c.han >= c.lat * 0.5) return 'zh'
  if (c.lat >= 4) return 'en'
  return null
}

const QUOTED =
  /^(user|the user|they|he|she|пользователь|юзер|клиент|заказчик|он|она|原文|上文|用户|对方)[^.!?。！？]{0,12}(said|says|asked|wants|mentioned|wrote|просил|сказал|сказала|спросил|пишет|хочет|упомянул|问|说)/i

const CODEISH =
  /[`{}<>]|:\/\/|[\w.-]+\.(?:ts|tsx|js|jsx|mjs|json|md|py|css|html|yml|yaml)\b|\/\w|=\S|\|\||\$\{|=>|\bfunction\b|\bconsole\.|\bimport\b|\bconst\b|\bdef\b|\bclass\b/

const SUSPECT = {
  ru: /не уверен|не уверена|неясно|непонятно|нужно ли|надо ли|можно ли|стоит ли|следует ли|правильно ли|верно ли|уточнить у|спросить у|какой вариант|что выбрать|как лучше|как правильнее|выбрать|или всё-таки|или все-таки|или нет|может,|может быть|не знаю,? (?:что|как)/i,
  en: /\b(?:not sure|unsure|unclear|whether|should i|should we|do i|need to (?:confirm|ask|know)|which (?:one|option|way)|wonder|maybe i should|i don't know|shall i|or not)\b/i,
  zh: /不确定|不清楚|不太确定|拿不准|要不要|该不该|是否应该|需要确认|还是先|用什么|怎么问/,
  ja: /べき|どうする|どっち|どれ|かな|だろう|でしょうか|ますか|ですか|したらいい|どうすれば/,
  ko: /까|나요|어떻게|해야|뭘|무엇|될까|할까|인가|일까|될지/,
}

/** A question addressed to the user is worth surfacing even without a doubt word. */
const SECOND_PERSON = {
  // \b is ASCII-only in JS, so Cyrillic needs unicode letter boundaries.
  ru: /(?<![\p{L}])(ты|тебе|тебя|тобой|вы|вам|вас|вами|твой|твоя|твои|твоё|ваш|ваша|ваши|ваше)(?![\p{L}])/iu,
  en: /\b(you|your|yours|yourself)\b/i,
}

const LENGTH = {
  ru: [8, 180],
  en: [10, 180],
  zh: [5, 90],
  ja: [6, 110],
  ko: [4, 110],
}

/**
 * Whether one sentence reads as a question the model is stuck on.
 *
 * @param {string} raw - one sentence from the reasoning stream.
 * @returns {boolean}
 */
export function looksLikeQuestion(raw) {
  let t = tidy(raw)
  if (!t) return false
  // Latin/Cyrillic prose carries several sentences per chunk because only
  // CJK and !? are terminators here; the question is the last one.
  if (!/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) {
    const parts = t.split(/[.!?]\s+/)
    if (parts.length > 1) t = parts[parts.length - 1]
  }
  if (QUOTED.test(t)) return false
  if (CODEISH.test(t)) return false
  // A quoted or reported question is someone else's words, not the model's own
  // doubt: bubbles show the model asking, never a quotation of a question.
  if (/["«»“”„]/.test(t) || /\.\.\.|…/.test(t)) return false
  if (/(?:^|\s)(?:https?:|www\.)/i.test(t)) return false

  const lang = langOf(t)
  if (!lang) return false

  const [min, max] = LENGTH[lang]
  if (t.length < min || t.length > max) return false
  const words = lang === 'en' ? t.split(/\s+/).filter(Boolean) : null
  if (words && (words.length < 4 || words.length > 26)) return false

  const asks = /[？?]["'”’)\]]?$/.test(t)
  if (lang === 'ru' || lang === 'en') {
    // Balance on purpose: markers carry the precise cases, and a bare "?"
    // would surface every rhetorical question the model asks itself. A doubt
    // word or a question addressed to the user is what a real one looks like.
    if (!asks) return false
    return SUSPECT[lang].test(t) || SECOND_PERSON[lang].test(t)
  }
  if (asks) return true
  return SUSPECT[lang].test(t) && /[。！!]?$/.test(t)
}

/** Normalize for duplicate comparison: drop punctuation, spaces, case. */
export function normalize(text) {
  return String(text || '')
    .replace(/[。！？!?；;，,、：:\s"'`«»“”„()（）【】[\]…·—–-]/g, '')
    .toLowerCase()
}

function bigrams(s) {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Whether two normalized questions say the same thing. */
export function similar(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  // A restated question keeps its opening: the model plans one, then asks it.
  if (Math.min(a.length, b.length) >= 24 && a.slice(0, 24) === b.slice(0, 24)) return true
  const ratio = a.length / b.length
  if (ratio > 0.6 && ratio < 1.66 && (a.includes(b) || b.includes(a))) return true
  const ga = bigrams(a)
  const gb = bigrams(b)
  if (!ga.size || !gb.size) return false
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter) > 0.66
}
