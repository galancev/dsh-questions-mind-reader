import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply } from '../index.js'

/** Minimal Cordis stand-in: listeners, effects, one route table, one prompt section. */
function makeHarness(config, services = {}) {
  const listeners = new Map()
  const routes = new Map()
  const sections = []
  const prompts = []

  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  const ctx = {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') ctx.disposers.push(disposer)
      return disposer
    },
    inject(deps, callback) {
      if (deps.includes('systemPrompt')) {
        callback({
          effect: (fn) => fn(),
          systemPrompt: { section: (section) => (sections.push(section), () => {}) },
        })
      }
    },
    get(name) {
      return services[name]
    },
    webServer,
    disposers: [],
  }

  apply(ctx, config)

  function emit(name, payload) {
    for (const handler of listeners.get(name) || []) handler(payload)
  }

  async function call(path, { method = 'GET', body, url } = {}) {
    const route = routes.get(path)
    assert.ok(route, 'route ' + path + ' registered')
    const req = new EventEmitter()
    req.method = method
    req.url = url || path
    req.headers = { host: '127.0.0.1:1234' }
    const response = { status: 0, headers: {}, payload: '' }
    const res = {
      writeHead(status, headers) {
        response.status = status
        response.headers = headers || {}
      },
      end(text) {
        response.payload = text || ''
      },
    }
    const done = route.handler(req, res)
    if (body !== undefined) {
      setImmediate(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)))
        req.emit('end')
      })
    }
    await done
    await new Promise((resolve) => setImmediate(resolve))
    return { ...response, json: () => JSON.parse(response.payload) }
  }

  return { ctx, emit, call, sections, prompts, routes }
}

function reasoning(harness, sessionId, text) {
  harness.emit('agent/assistant-stream', {
    agent: { id: sessionId },
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text } },
  })
}

test('registered routes and prompt section', () => {
  const harness = makeHarness({})
  assert.deepEqual([...harness.routes.keys()].sort(), ['/dsh-mq/answer', '/dsh-mq/debug', '/dsh-mq/state'])
  assert.equal(harness.sections.length, 1)
  assert.equal(harness.sections[0].name, 'dsh-mind-questions')
  assert.match(harness.sections[0].text, /\[\[ask\]\]/)
})

test('two marked questions in one step both survive', async () => {
  const harness = makeHarness({})
  reasoning(
    harness,
    's1',
    '[[ask]]Первый вопрос про формат?[[/ask]] текст [[ask]]Второй вопрос про миграцию?[[/ask]]',
  )
  const body = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.deepEqual(body.questions.map((q) => q.text), [
    'Первый вопрос про формат?',
    'Второй вопрос про миграцию?',
  ])
})

test('prose that merely quotes the markers is not a question', async () => {
  const harness = makeHarness({})
  reasoning(
    harness,
    's1',
    '[[ask]]Достро... inside a quoted fragment to a later[[/ask]] [[ask]]Какой формат выбрать?[[/ask]]',
  )
  const body = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.deepEqual(body.questions.map((q) => q.text), ['Какой формат выбрать?'])
})

test('marked question reaches the state route', async () => {
  const harness = makeHarness({})
  reasoning(harness, 's1', 'Думаю. [[ask]]Какой формат выбрать?[[/ask]]')
  const state = await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })
  const body = state.json()
  assert.equal(body.questions.length, 1)
  assert.equal(body.questions[0].text, 'Какой формат выбрать?')
  assert.equal(body.questions[0].origin, 'marker')
  assert.equal(body.questions[0].status, 'open')
})

test('state is scoped to the requested session', async () => {
  const harness = makeHarness({})
  reasoning(harness, 's1', '[[ask]]Первый вопрос?[[/ask]]')
  reasoning(harness, 's2', '[[ask]]Второй вопрос?[[/ask]]')
  const first = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  const second = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s2' })).json()
  assert.deepEqual(first.questions.map((q) => q.text), ['Первый вопрос?'])
  assert.deepEqual(second.questions.map((q) => q.text), ['Второй вопрос?'])
  const none = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state' })).json()
  assert.deepEqual(none.questions, [])
})

test('heuristic question is detected when markers are off', async () => {
  const harness = makeHarness({ markers: false })
  assert.equal(harness.sections.length, 0)
  reasoning(harness, 's1', 'Так, думаю. Какой формат выбрать для конфига?')
  const body = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.equal(body.questions.length, 1)
  assert.equal(body.questions[0].origin, 'auto')
  assert.match(body.questions[0].text, /Какой формат выбрать/)
})

test('answer steers into the session and settles the question', async () => {
  const prompts = []
  const harness = makeHarness(
    {},
    {
      sessionController: {
        prompt(request) {
          prompts.push(request)
          return Promise.resolve({ accepted: true })
        },
      },
    },
  )
  reasoning(harness, 's1', '[[ask]]Какой формат выбрать?[[/ask]]')
  const question = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json().questions[0]

  const answered = await harness.call('/dsh-mq/answer', {
    method: 'POST',
    body: { id: question.id, text: 'JSON' },
  })
  assert.equal(answered.status, 200)
  assert.equal(answered.json().ok, true)

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].mode, 'steer')
  assert.equal(prompts[0].sessionId, 's1')
  assert.match(prompts[0].content[0].text, /Какой формат выбрать\?/)
  assert.match(prompts[0].content[0].text, /JSON/)

  const after = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.equal(after.questions[0].status, 'answered')

  const again = await harness.call('/dsh-mq/answer', {
    method: 'POST',
    body: { id: question.id, text: 'YAML' },
  })
  assert.equal(again.status, 409)
})

test('text or tool output marks open questions as proceeded', async () => {
  const harness = makeHarness({})
  reasoning(harness, 's1', '[[ask]]Какой формат выбрать?[[/ask]]')
  harness.emit('agent/assistant-stream', {
    agent: { id: 's1' },
    frame: { type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'Готово.' } },
  })
  const body = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.equal(body.questions[0].status, 'proceeded')
})

test('model-side resolution marks the question solved', async () => {
  const harness = makeHarness({})
  reasoning(harness, 's1', '[[ask]]Какой формат выбрать?[[/ask]] [[done]]Беру JSON[[/done]]')
  const body = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.equal(body.questions[0].status, 'solved')
})

test('foreign hosts are refused', async () => {
  const harness = makeHarness({})
  const route = harness.routes.get('/dsh-mq/state')
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = '/dsh-mq/state?session=s1'
  req.headers = { host: 'evil.example.com' }
  let status = 0
  const res = { writeHead(code) { status = code }, end() {} }
  route.handler(req, res)
  assert.equal(status, 403)
})

test('a foreign question is translated through ctx.translator', async () => {
  const calls = []
  const harness = makeHarness(
    {},
    {
      translator: {
        resolve: (spec) => spec,
        translate: async (spec) => {
          calls.push(spec)
          return 'Какой формат использовать?'
        },
      },
    },
  )
  reasoning(harness, 's1', '[[ask]]Which format should I use?[[/ask]]')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const body = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].targetLanguage, 'ru')
  assert.equal(body.questions[0].text, 'Which format should I use?')
  assert.equal(body.questions[0].translated, 'Какой формат использовать?')
})

test('a russian question is not sent to the translator', async () => {
  let calls = 0
  const harness = makeHarness(
    {},
    {
      translator: {
        resolve: (spec) => spec,
        translate: async () => {
          calls++
          return 'x'
        },
      },
    },
  )
  reasoning(harness, 's1', '[[ask]]Какой формат выбрать?[[/ask]]')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls, 0)
  const body = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.equal(body.questions[0].translated, undefined)
})

test('disabled plugin serves no questions', async () => {
  const harness = makeHarness({ enabled: false })
  reasoning(harness, 's1', '[[ask]]Какой формат выбрать?[[/ask]]')
  const body = (await harness.call('/dsh-mq/state', { url: '/dsh-mq/state?session=s1' })).json()
  assert.deepEqual(body.questions, [])
})
