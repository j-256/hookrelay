import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { capture, outputPath } from './browser.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = outputPath(root, 'Capture the actual event console using a synthetic, in-memory database.');
const { handleAdminEvents } = await import('../../src/admin/events.ts');
const receivedAt = '2026-01-15T14:30:00.000Z';
const examples = [
  ['statuspage', 'incident.updated', 'Elevated API latency', 'exhausted', 'Delivery attempts exhausted'],
  ['github', 'push', 'Update deployment documentation', 'delivered', null],
  ['cloudevents', 'com.example.build.completed', 'Production build completed', 'queued', null],
];
const events = examples.map(([source, type, title], index) => ({
  id: `event-example-${index + 1}`, received_at: receivedAt,
  sub_name: `${source}-updates`, source, type, title,
  url: 'https://example.com/events', severity: index === 0 ? 'warning' : 'info', fanout_results: '{}',
}));
const deliveries = examples.map(([, , , status, error], index) => ({
  event_id: events[index].id, sink_name: 'operations', status,
  attempts: status === 'exhausted' ? 5 : status === 'delivered' ? 1 : 0,
  last_error: error, decision_reason: null, updated_at: receivedAt,
}));
const database = {
  prepare(sql) {
    const statement = {
      bind() { return statement; },
      async first() {
        assert.match(sql, /^SELECT COUNT\(\*\) AS total FROM events/);
        return { total: events.length };
      },
      async all() {
        if (sql.includes('FROM deliveries')) return { results: deliveries };
        assert.match(sql, /FROM events/);
        return { results: events };
      },
    };
    return statement;
  },
};
const response = await handleAdminEvents(new Request('https://example.com/admin/events'), {
  TEST_BYPASS_ACCESS: '1', EVENTS_DB: database,
});
assert.equal(response.status, 200);
await capture({ output, html: await response.text(), viewport: { width: 1600, height: 1000 },
  async ready(page) {
    await page.getByRole('heading', { name: 'Event activity', exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), events.length);
    await page.getByRole('link', { name: 'Production build completed' }).waitFor();
  },
});
