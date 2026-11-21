/**
 * Smoke-run the Client module outside DSH: stub the module loader, React
 * hooks, and the Cordis context, then check that apply() registers the
 * shell.overlay entry and that the component renders without throwing.
 */

let registered = null

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registered = spec
    },
  },
}

/* Minimal React: enough hook semantics to call the component once. */
const hooks = []
let hookIndex = 0
const React = {
  Fragment: Symbol('fragment'),
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    const index = hookIndex++
    if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (next) => (hooks[index] = typeof next === 'function' ? next(hooks[index]) : next)]
  },
  useEffect() {},
  useMemo(factory) {
    return factory()
  },
  useRef(value) {
    const index = hookIndex++
    if (hooks[index] === undefined) hooks[index] = { current: value }
    return hooks[index]
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

await import('../client.js')
if (!registered || registered.id !== 'dsh-mind-questions') throw new Error('module id not registered')
if (typeof registered.factory !== 'function') throw new Error('factory missing')

const module_ = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
if (!module_ || typeof module_.apply !== 'function') throw new Error('apply missing')
if (!Array.isArray(module_.inject) || !module_.inject.includes('slots')) throw new Error('inject list missing slots')

const dictionaries = new Map()
const registrations = []
let injected = null

const ctx = {
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposer()
  },
  locale: {
    register(name, dict) {
      dictionaries.set(name, dict)
    },
    bind(name) {
      return (key) => {
        const dict = dictionaries.get(name) || {}
        return dict.en?.[key] ?? key
      }
    },
  },
  sessions: {
    list: {
      getSnapshot: () => ({ byId: {} }),
      subscribe: () => () => {},
    },
  },
  slots: {
    inject(name, callback) {
      injected = name
      callback()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
}

module_.apply(ctx)

if (!dictionaries.has('mindQuestions')) throw new Error('locale dictionary not registered')
if (injected !== 'shell.overlay') throw new Error('injected into ' + injected)
if (registrations.length !== 1) throw new Error('expected one registration')
const { options, Component } = registrations[0]
if (options.name !== 'shell.overlay' || options.id !== 'mind-questions') {
  throw new Error('bad registration options ' + JSON.stringify(options))
}

/* Render once with no active session: the component must return cleanly. */
hookIndex = 0
const output = Component({
  t: (key) => key,
  useActiveSessionId: () => undefined,
})
if (!output || output.props === undefined) throw new Error('component returned nothing usable')

/* Render once with a session and two questions, using a fake fetch. */
const asked = []
globalThis.fetch = async (url) => {
  asked.push(url)
  return {
    ok: true,
    json: async () => ({
      enabled: true,
      maxBubbles: 3,
      ttlSec: 30,
      running: true,
      questions: [
        { id: 'q1', text: 'Какой формат выбрать?', ts: Date.now(), status: 'open', origin: 'marker' },
        { id: 'q2', text: 'Добавлять миграцию?', ts: Date.now(), status: 'proceeded', origin: 'auto' },
      ],
    }),
  }
}

hookIndex = 0
const withSession = Component({
  t: (key) => key,
  useActiveSessionId: () => 'session-1',
})
if (!withSession) throw new Error('session render returned nothing')

console.log('client smoke ok:', options.id, '| dictionaries:', [...dictionaries.keys()].join(','))
