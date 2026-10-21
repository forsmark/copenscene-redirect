/**
 * The page's script, run in a `vm` context with a fake fetch, location and
 * document, for each scenario of `site-availability` in forsmark/copenscene.
 * Run with `node --test`; it needs nothing installed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
const SITE = 'https://devbox.tailf4d52f.ts.net';
const HEALTH = `${SITE}/api/health`;

const answer = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
/** A request that never answers, until its signal aborts it. */
const silent = (init) =>
  new Promise((_, reject) =>
    init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
  );

/**
 * Open the page at `address` with `answers`, url → function of the request's
 * init returning an answer or a promise. `timeoutsFire` makes the 3-second
 * timer fire at once; otherwise it never does.
 */
function open(address, answers, { timeoutsFire = false } = {}) {
  const url = new URL(address);
  const asked = [];
  const elements = {};
  const element = (id) =>
    (elements[id] ??= {
      hidden: true,
      disabled: false,
      textContent: '',
      listeners: [],
      addEventListener(type, listener) {
        this.listeners.push(listener);
      },
    });
  const page = {
    replacedWith: null,
    asked,
    elements,
    body: { dataset: {} },
  };
  const context = {
    location: {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace: (to) => (page.replacedWith = to),
    },
    document: { getElementById: element, body: page.body },
    fetch: async (target, init) => {
      asked.push({ target, init });
      const reply = answers[target];
      if (!reply) throw new TypeError('Failed to fetch');
      return reply(init);
    },
    AbortController,
    setTimeout: (fn) => (timeoutsFire ? (queueMicrotask(fn), 1) : 1),
    clearTimeout: () => {},
  };
  vm.runInNewContext(SCRIPT, context);
  page.retry = () => element('retry').listeners[0]();
  page.shown = () => (element('notice').hidden ? null : page.body.dataset.state);
  return page;
}

/** Let every pending promise of the page settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const maintenanceOff = { '/status.json': () => answer(200, { maintenance: false }) };
const maintenanceOn = { '/status.json': () => answer(200, { maintenance: true }) };

describe('the redirect page', () => {
  it('forwards to the same path, query and fragment when the site answers 200', async () => {
    const page = open('https://copenscene.rocks/concerts/a-slug?via=digest#tickets', {
      ...maintenanceOff,
      [HEALTH]: () => answer(200),
    });
    await settle();
    assert.equal(page.replacedWith, `${SITE}/concerts/a-slug?via=digest#tickets`);
    assert.equal(page.shown(), null);
  });

  it('sends a browser without script to the front page after a second, from <noscript>', () => {
    const refresh =
      /<noscript><meta http-equiv="refresh" content="1; url=https:\/\/devbox\.tailf4d52f\.ts\.net\/" \/><\/noscript>/;
    assert.match(PAGE, refresh);
    // No refresh outside <noscript>: it would forward a browser still checking.
    assert.equal(PAGE.match(/http-equiv="refresh"/g).length, 1);
  });

  it('shows the downtime page and stays when the site does not answer', async () => {
    const page = open('https://copenscene.rocks/v/a-venue', {
      ...maintenanceOff,
      [HEALTH]: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await settle();
    assert.equal(page.replacedWith, null);
    assert.equal(page.shown(), 'downtime');
    assert.equal(page.elements.downtime.hidden, false);
    assert.equal(page.elements.maintenance.hidden, true);
  });

  it('shows the downtime page when the site does not answer within 3 seconds', async () => {
    const page = open(
      'https://copenscene.rocks/',
      { ...maintenanceOff, [HEALTH]: silent },
      { timeoutsFire: true },
    );
    await settle();
    assert.equal(page.replacedWith, null);
    assert.equal(page.shown(), 'downtime');
  });

  it('shows the downtime page when the health check answers 503', async () => {
    const page = open('https://copenscene.rocks/concerts/a-slug', {
      ...maintenanceOff,
      [HEALTH]: () => answer(503, { status: 'degraded' }),
    });
    await settle();
    assert.equal(page.replacedWith, null);
    assert.equal(page.shown(), 'downtime');
  });

  it('checks again on the button and forwards to the first address once the site is back', async () => {
    let healthy = false;
    const page = open('https://copenscene.rocks/v/a-venue?q=1#map', {
      ...maintenanceOff,
      [HEALTH]: () => answer(healthy ? 200 : 502),
    });
    await settle();
    assert.equal(page.shown(), 'downtime');
    healthy = true;
    await page.retry();
    assert.equal(page.replacedWith, `${SITE}/v/a-venue?q=1#map`);
    assert.equal(page.asked.filter((a) => a.target === HEALTH).length, 2);
  });

  it('shows the maintenance page and stays when maintenance is on, though the site answers', async () => {
    const page = open('https://copenscene.rocks/concerts/a-slug', {
      ...maintenanceOn,
      [HEALTH]: () => answer(200),
    });
    await settle();
    assert.equal(page.replacedWith, null);
    assert.equal(page.shown(), 'maintenance');
    assert.equal(page.elements.maintenance.hidden, false);
    assert.equal(page.elements.downtime.hidden, true);
  });

  it('reads the status file past every cache', async () => {
    const page = open('https://copenscene.rocks/', { ...maintenanceOn });
    await settle();
    const status = page.asked.find((a) => a.target === '/status.json');
    assert.equal(status.init.cache, 'no-store');
  });

  for (const [what, status] of [
    ['missing', () => answer(404)],
    ['broken', () => ({ ok: true, status: 200, json: async () => JSON.parse('{') })],
    ['unreachable', () => Promise.reject(new TypeError('Failed to fetch'))],
  ]) {
    it(`goes on to the health check and forwards when the status file is ${what}`, async () => {
      const page = open('https://copenscene.rocks/a/an-act?x=1', {
        '/status.json': status,
        [HEALTH]: () => answer(200),
      });
      await settle();
      assert.equal(page.replacedWith, `${SITE}/a/an-act?x=1`);
    });
  }

  it('has the downtime and maintenance texts', () => {
    assert.match(PAGE, /<h1>CopenScene isn't answering right now\.<\/h1>\s*<p>Check again in a few minutes\.<\/p>/);
    assert.match(PAGE, /<h1>CopenScene is down for maintenance\.<\/h1>\s*<p>Back soon, after a quick changeover\.<\/p>/);
  });

  it('is served the same as index.html and as 404.html', () => {
    assert.equal(readFileSync(join(ROOT, '404.html'), 'utf8'), PAGE);
  });

  it('ships with maintenance off', () => {
    const status = JSON.parse(readFileSync(join(ROOT, 'status.json'), 'utf8'));
    assert.deepEqual(status, { maintenance: false });
  });
});
