import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const load = createRequire(import.meta.resolve('wrangler'))
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = load('miniflare')
const { transform } = load('esbuild')

test('workerd delivers producer failures and successes through the real sanitized Tail handler', { timeout: 15_000 }, async () => {
  const marker = 'synthetic-private-runtime-marker'
  const code = await transform(await readFile('src/telemetry/tail.ts', 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022' })
  const summaries = []
  let captured
  const complete = new Promise(resolve => { captured = resolve })
  const runtime = new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.NONE),
    workers: [{
      name: 'producer', compatibilityDate: '2026-06-01', modules: true,
      script: `export default { fetch(request) {
        console.log('${marker}');
        if (request.method === 'POST') throw new Error('${marker}');
        return new Response('ok', { status: 202 });
      } }`,
      tails: ['sanitizer'],
    }, {
      name: 'sanitizer', compatibilityDate: '2026-06-01',
      modules: [{ type: 'ESModule', path: 'capture.js', contents: `
        import worker from './tail.js';
        export default { async tail(events, env) {
          const output = [];
          const original = console.log;
          console.log = value => output.push(value);
          try { await worker.tail(events); } finally { console.log = original; }
          for (const body of output) await env.CAPTURE.fetch('https://capture.invalid', { method: 'POST', body });
        } };
      ` }, { type: 'ESModule', path: 'tail.js', contents: code.code }],
      serviceBindings: { CAPTURE: async request => {
        summaries.push(JSON.parse(await request.text()))
        if (summaries.length === 2) captured()
        return new Response(null, { status: 204 })
      } },
    }],
  }))
  try {
    const success = await runtime.dispatchFetch(`https://hooks.example/hook/github/${marker}?token=${marker}`, { headers: { authorization: marker } })
    assert.equal(success.status, 202)
    const failure = await runtime.dispatchFetch(`https://hooks.example/hook/github/${marker}`, { method: 'POST' })
    assert.equal(failure.status, 500)
    await complete
    assert.equal(summaries.length, 2)
    assert.ok(summaries.every(row => row.event === 'hookrelay.invocation' && row.handler === 'fetch' && row.route === 'hook'))
    assert.ok(summaries.some(row => row.outcome === 'ok' && row.status === 202 && row.logCount === 1))
    assert.ok(summaries.some(row => row.outcome === 'exception' && row.exceptionCount === 1))
    assert.ok(!JSON.stringify(summaries).includes(marker))
  } finally { await runtime.dispose() }
})
