import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parse } from 'jsonc-parser'
import { checkProductionMigrations, parseReleaseMigrationConfig } from '../../scripts/release-check.ts'

const SECRET = 'synthetic-private-marker-DO-NOT-RETAIN'
const VERSION = '11111111-1111-4111-8111-111111111111'
const timestamp = 1_800_000_000_000
const producer = (overrides = {}) => ({
  name: 'synthetic-producer',
  d1_databases: [{ binding: 'EVENTS_DB', database_id: VERSION }],
  observability: { enabled: true, logs: { enabled: true, persist: false }, traces: { enabled: false }, issues: { enabled: false } },
  tail_consumers: [{ service: 'synthetic-telemetry' }],
  ...overrides,
})
const event = (overrides = {}) => ({
  eventTimestamp: timestamp,
  scriptName: SECRET,
  scriptTags: [SECRET],
  scriptVersion: { id: VERSION, tag: SECRET },
  outcome: 'ok', cpuTime: 2.5, wallTime: 50, truncated: false,
  event: {
    request: { method: 'POST', url: `https://hooks.example/hook/github/${encodeURIComponent(SECRET)}?token=${SECRET}`, headers: { authorization: SECRET } },
    response: { status: 202 },
  },
  logs: [{ level: 'error', message: [{ token: SECRET }], errorInfo: [{ message: SECRET, stack: SECRET }] }],
  exceptions: [{ name: SECRET, message: SECRET, stack: SECRET }],
  diagnosticsChannelEvents: [{ channel: SECRET, message: SECRET }],
  tailAttributes: { secret: SECRET },
  ...overrides,
})

test('deployment preflight rejects raw producer persistence before database access', () => {
  assert.doesNotThrow(() => parseReleaseMigrationConfig(JSON.stringify(producer())))
  for (const overrides of [
    { observability: { enabled: true } },
    { observability: { enabled: true, logs: { enabled: true, persist: true } } },
    { observability: { enabled: true, logs: { enabled: true, persist: false }, traces: { enabled: true } } },
    { observability: { enabled: true, logs: { enabled: true, persist: false, destinations: ['raw-export'] } } },
    { tail_consumers: [] },
    { tail_consumers: [{ service: 'synthetic-producer' }] },
    { logpush: true },
  ]) assert.throws(() => parseReleaseMigrationConfig(JSON.stringify(producer(overrides))), /telemetry/i)
  assert.doesNotThrow(() => parseReleaseMigrationConfig(JSON.stringify(producer({ observability: { enabled: false }, tail_consumers: [] }))))
})

test('streaming consumers and disabled-logging bypasses cannot export raw producer events', async () => {
  for (const config of [
    producer({ streaming_tail_consumers: [{ service: 'synthetic-raw-exporter' }] }),
    producer({ observability: { enabled: false }, tail_consumers: [], streaming_tail_consumers: [{ service: 'synthetic-raw-exporter' }] }),
    producer({ observability: { enabled: false }, tail_consumers: [{ service: 'synthetic-raw-exporter' }] }),
    producer({ observability: { enabled: false }, tail_consumers: 'synthetic-raw-exporter' }),
  ]) {
    assert.throws(() => parseReleaseMigrationConfig(JSON.stringify(config)), /telemetry/i)
    let downstreamReads = 0
    await assert.rejects(() => checkProductionMigrations({
      readConfig: async () => JSON.stringify(config),
      listMigrations: async () => { downstreamReads++; return [] },
      query: async () => { downstreamReads++; return [] },
      log: () => {},
    }), /telemetry/i)
    assert.equal(downstreamReads, 0)
  }
  assert.doesNotThrow(() => parseReleaseMigrationConfig(JSON.stringify(producer({
    observability: { enabled: false, logs: { enabled: false, persist: false }, traces: { enabled: false } },
    tail_consumers: [], streaming_tail_consumers: [],
  }))))
})

test('tail summaries retain useful execution evidence and exclude all raw event material', async () => {
  const { sanitizeTailEvent } = await import('../../src/telemetry/tail.ts')
  const input = event()
  Object.defineProperty(input.event.request, 'headers', { get() { throw new Error(SECRET) } })
  input.event.request.getUnredacted = () => { throw new Error(SECRET) }
  const summary = sanitizeTailEvent(input)
  assert.deepEqual(summary, {
    schemaVersion: 1, event: 'hookrelay.invocation', handler: 'fetch', route: 'hook', method: 'POST',
    outcome: 'ok', status: 202, eventTimestampMs: timestamp, versionId: VERSION,
    cpuTimeMs: 2.5, wallTimeMs: 50, logCount: 1, warningCount: 0, errorCount: 1, exceptionCount: 1,
    truncated: false, logScanLimited: false,
  })
  assert.ok(!JSON.stringify(summary).includes(SECRET))
})

test('unknown handler metadata and invalid strings cannot become telemetry labels', async () => {
  const { sanitizeTailEvent } = await import('../../src/telemetry/tail.ts')
  const result = sanitizeTailEvent(event({
    event: { arbitrary: SECRET }, outcome: SECRET, cpuTime: NaN, wallTime: -1,
    scriptVersion: { id: SECRET }, eventTimestamp: Infinity,
  }))
  assert.equal(result.handler, 'unknown')
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.cpuTimeMs, null)
  assert.equal(result.wallTimeMs, null)
  assert.equal(result.versionId, null)
  assert.equal(result.eventTimestampMs, null)
  assert.ok(!JSON.stringify(result).includes(SECRET))
  assert.equal(sanitizeTailEvent(null), null)
  assert.equal(sanitizeTailEvent(SECRET), null)
})

test('queue cron email and operator routes use fixed categories without private labels', async () => {
  const { sanitizeTailEvent } = await import('../../src/telemetry/tail.ts')
  for (const [source, handler, route] of [
    [{ queue: SECRET, batchSize: 2 }, 'queue', null],
    [{ cron: SECRET, scheduledTime: timestamp }, 'scheduled', null],
    [{ mailFrom: SECRET, rcptTo: SECRET, rawSize: 12 }, 'email', null],
    [{ request: { url: `https://hooks.example/admin/events/${SECRET}/raw`, method: 'GET' } }, 'fetch', 'admin'],
    [{ request: { url: `https://hooks.example/management/github-app-key-verification?proof=${SECRET}`, method: 'POST' } }, 'fetch', 'github_app_key_verification'],
    [{ request: { url: 'https://hooks.example/admin/api/v1', method: 'POST' } }, 'fetch', 'management'],
    [{ request: { url: `https://hooks.example/${SECRET}`, method: SECRET } }, 'fetch', 'other'],
  ]) {
    const result = sanitizeTailEvent(event({ event: source }))
    assert.equal(result.handler, handler)
    assert.equal(result.route, route)
    assert.ok(!JSON.stringify(result).includes(SECRET))
  }
})

test('tail handler bounds output and reports malformed and omitted events without private exceptions', async () => {
  const { default: worker, TELEMETRY_LIMITS } = await import('../../src/telemetry/tail.ts')
  const messages = []
  const original = console.log
  try {
    console.log = value => messages.push(JSON.parse(value))
    const bad = Object.defineProperty({}, 'event', { get() { throw new Error(SECRET) } })
    await worker.tail([bad, ...Array.from({ length: TELEMETRY_LIMITS.BATCH_EVENTS + 3 }, () => event())])
  } finally { console.log = original }
  assert.equal(messages.filter(row => row.event === 'hookrelay.invocation').length, TELEMETRY_LIMITS.BATCH_EVENTS - 1)
  assert.deepEqual(messages.at(-1), { schemaVersion: 1, event: 'hookrelay.telemetry.coverage', processed: TELEMETRY_LIMITS.BATCH_EVENTS, malformed: 1, dropped: 4 })
  assert.ok(!JSON.stringify(messages).includes(SECRET))
})

test('tail counters bound log inspection and keep telemetry failures out of exception output', async () => {
  const { default: worker, sanitizeTailEvent, TELEMETRY_LIMITS } = await import('../../src/telemetry/tail.ts')
  const logs = Array.from({ length: TELEMETRY_LIMITS.LOG_ENTRIES + 1 }, () => ({ level: 'warn', message: SECRET }))
  const result = sanitizeTailEvent(event({ logs }))
  assert.equal(result.warningCount, TELEMETRY_LIMITS.LOG_ENTRIES)
  assert.equal(result.logScanLimited, true)
  const original = console.log
  try {
    console.log = () => { throw new Error(SECRET) }
    await assert.doesNotReject(() => worker.tail([event()]))
  } finally { console.log = original }
})

test('checked deployment configurations separate raw producer telemetry from retained safe summaries', async () => {
  const source = parse(await readFile('wrangler.jsonc', 'utf8'))
  assert.doesNotThrow(() => parseReleaseMigrationConfig(JSON.stringify(source)))
  assert.equal(source.observability.logs.persist, false)
  assert.equal(source.tail_consumers[0].service, 'hookrelay-telemetry')
  const tail = parse(await readFile('wrangler.telemetry.jsonc', 'utf8'))
  assert.equal(tail.workers_dev, false)
  assert.equal(tail.preview_urls, false)
  assert.equal(tail.observability.redact_query_string, true)
  assert.equal(tail.observability.logs.persist, true)
  assert.equal(tail.observability.logs.invocation_logs, false)
  assert.equal(tail.observability.traces.enabled, false)
  assert.equal(tail.tail_consumers, undefined)
  assert.equal(tail.streaming_tail_consumers, undefined)
})
