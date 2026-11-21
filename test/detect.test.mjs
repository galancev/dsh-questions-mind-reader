import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MarkerScanner,
  SentenceStream,
  isQuestionText,
  langOf,
  looksLikeQuestion,
  normalize,
  scriptCounts,
  similar,
  tidy,
} from '../lib/detect.js'

test('russian question with a question mark is detected', () => {
  assert.equal(looksLikeQuestion('Какой формат выбрать для конфига?'), true)
  assert.equal(looksLikeQuestion('Стоит ли добавлять миграцию?'), true)
})

test('russian statement is not a question', () => {
  assert.equal(looksLikeQuestion('Файл лежит в корне проекта.'), false)
  assert.equal(looksLikeQuestion('Проверил тесты, всё зелёное.'), false)
})

test('english question needs a question word or doubt marker', () => {
  assert.equal(looksLikeQuestion('Should I keep the legacy field?'), true)
  assert.equal(looksLikeQuestion('The build passed after the change?'), false)
})

test('bare rhetorical analysis questions stay out', () => {
  assert.equal(looksLikeQuestion('Which element is the center column?'), false)
  assert.equal(looksLikeQuestion('What about using the rightbar attributes?'), false)
  assert.equal(looksLikeQuestion('Нужно ли ещё один рестарт?'), true)
  assert.equal(looksLikeQuestion('А что если переставить блок?'), false)
})

test('a question addressed to the user is detected without a doubt word', () => {
  assert.equal(looksLikeQuestion('Тебе удобнее 160 или 200 пикселей?'), true)
  assert.equal(looksLikeQuestion('Do you want the strip a bit wider?'), true)
  assert.equal(looksLikeQuestion('Может, поднять до 60 секунд?'), true)
})

test('code, paths and user quotes are rejected', () => {
  assert.equal(looksLikeQuestion('const value = compute()?'), false)
  assert.equal(looksLikeQuestion('Пользователь спросил, какой формат выбрать?'), false)
  assert.equal(looksLikeQuestion('Открыть https://example.com/docs?'), false)
})

test('chinese question is detected', () => {
  assert.equal(looksLikeQuestion('这个字段要不要保留？'), true)
  assert.equal(looksLikeQuestion('已经改好了配置文件。'), false)
})

test('a mixed step keeps a question raised in another language', () => {
  const counts = scriptCounts('Let me check the layout math once more, then the numbers.')
  assert.equal(counts.lat > 30, true)
  assert.equal(langOf('Какой формат выбрать?'), 'ru')
  assert.equal(looksLikeQuestion('Какой формат выбрать?'), true)
  assert.equal(looksLikeQuestion('Should I keep the legacy field?'), true)
})

test('tidy strips list markers and quotes', () => {
  assert.equal(tidy('- «Какой формат выбрать?»'), 'Какой формат выбрать?')
  assert.equal(tidy('Ну, так что дальше?'), 'что дальше?')
})

test('normalize and similar collapse restatements', () => {
  const a = normalize('Какой формат выбрать?')
  const b = normalize('какой формат выбрать')
  assert.equal(a, b)
  assert.equal(similar(normalize('Какой формат выбрать для конфига?'), b), true)
})

test('marker scanner finds pairs split across deltas', () => {
  const scanner = new MarkerScanner()
  assert.deepEqual(scanner.push('Думаю. [[as'), [])
  assert.deepEqual(scanner.push('k]]Какой формат выбрать?[[/'), [])
  assert.deepEqual(scanner.push('ask]]'), [{ kind: 'ask', text: 'Какой формат выбрать?' }])
  assert.deepEqual(scanner.push(' Итог: [[done]]Беру JSON[[/done]]'), [
    { kind: 'done', text: 'Беру JSON' },
  ])
})

test('marker scanner ignores already consumed text', () => {
  const scanner = new MarkerScanner()
  assert.equal(scanner.push('[[ask]]Первый вопрос?[[/ask]]').length, 1)
  assert.equal(scanner.push(' продолжение').length, 0)
  assert.equal(scanner.push('[[ask]]Второй вопрос?[[/ask]]').length, 1)
})

test('a marker named in prose does not swallow the real question', () => {
  const scanner = new MarkerScanner()
  const events = scanner.push(
    'I will write [[ask]] like this. Let me plan:\n- [[ask]]Какой формат выбрать?[[/ask]]\nдальше',
  )
  assert.deepEqual(events, [{ kind: 'ask', text: 'Какой формат выбрать?' }])
})

test('marker text drops markdown noise and prose without a question mark', () => {
  const scanner = new MarkerScanner()
  assert.deepEqual(scanner.push('[[ask]]`Какой формат?`[[/ask]]'), [
    { kind: 'ask', text: 'Какой формат?' },
  ])
  const escaped = scanner.push('[[ask]]\\`Какой формат?\\`[[/ask]]')
  assert.deepEqual(escaped, [{ kind: 'ask', text: 'Какой формат?' }])
  const prose = scanner.push('[[ask]]Достро... inside a quoted fragment to a later[[/ask]]')
  assert.equal(isQuestionText(prose[0].text), false)
  assert.equal(isQuestionText('Какой формат?'), true)
})

test('a restated question merges with its plan', () => {
  const planned = normalize('Should I keep the strip at 160 px or let you tune it in config?')
  const asked = normalize('Should I keep the strip at 160 px, or do you want it configurable per window?')
  assert.equal(similar(planned, asked), true)
  assert.equal(similar(normalize('Какой формат выбрать для конфига?'), normalize('Стоит ли добавить миграцию?')), false)
})

test('quoted or reported questions are not bubbles', () => {
  assert.equal(looksLikeQuestion('My summary said "Should I keep the strip at 160 px?"'), false)
  assert.equal(looksLikeQuestion('Мой план был такой: «Стоит ли оставить 160 px?»'), false)
  assert.equal(looksLikeQuestion('Should I keep the strip at 160 px?'), true)
})

test('sentence stream skips fenced code and yields trailing question', () => {
  const stream = new SentenceStream()
  assert.deepEqual(stream.push('```ts\nconst a = 1\n```\n'), [])
  assert.deepEqual(stream.push('Теперь думаю дальше！'), ['Теперь думаю дальше！'])
  assert.deepEqual(stream.push('А если иначе?'), ['А если иначе?'])
  assert.deepEqual(stream.push(''), [])
})
