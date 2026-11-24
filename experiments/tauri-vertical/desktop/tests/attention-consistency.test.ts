/** Real main.ts/xterm; only the Tauri and native notification boundaries are mocked.
 * node --test tests/attention-consistency.test.ts                         (skipped)
 * ATTENTION_CONSISTENCY_BROWSER=1 node --test tests/attention-consistency.test.ts
 * ATTENTION_CONSISTENCY_BROWSER=1 ENGINE=webkit node --test tests/attention-consistency.test.ts
 * Each case owns an ephemeral context; no runner, provider, user profile or OS settings.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';

async function installMock(page: Page, structured: boolean, preferences = false, runner = false) {
  await page.addInitScript(({ structured, preferences, runner }) => {
    const w = window as any;
    const sessions: any[] = [
      { id: 'foreground', title: 'Claude foreground', kind: 'claude', transport: 'pty', status: 'running' },
      { id: 'background', title: 'Claude background', kind: 'claude', transport: 'pty', status: 'running' },
      { id: 'old-failed', title: 'Codex historical failure', kind: 'codex', transport: 'pty', status: 'failed' },
    ].map(s => ({ ...s, cwd: '/synthetic/attention-consistency', rows: 24, cols: 80 }));
    if (structured) sessions.push({ id: 'permissions', title: 'Codex permissions', kind: 'codex',
      transport: 'app-server', status: 'running', cwd: '/synthetic/permissions', rows: 24, cols: 80,
      codex: { generation: 1, status: 'running', nativeThreadId: 'synthetic' } });
    let focused = true, visibility = 'visible', pending = 0, permissionReads = 0, statusReads = 0, evidence: any;
    const badges: (number | undefined)[] = [], unexpected: string[] = [], calls: string[] = [];
    const resizes: any[] = [], notifications: any[] = [];
    // Deliberately omit terminalStreamVersion: exercise main's supported legacy PTY path.
    let maxConcurrentSessions = 2;
    const settings = () => ({schemaVersion: 1, maxConcurrentSessions, maxSupportedSessions: 8, warning: null});
    // runner: a 1.4 E runner (agentAttentionVersion) that records a confirmed process end as `ended`.
    const agents = new Map<string, any>(), marks: any[] = [];
    const record = (id: string) => agents.get(id) ?? { epoch: 5, state: null, changedAt: null, stateFrame: null, turnOpen: false, turnStartedAt: null,
      turnEndedAt: null, lastTurnMs: null, turnInterrupted: false, alertSeq: 0, seenSeq: 0, finishedUnseen: false, pending: {} };
    const rows = () => sessions.map(s => runner && (['running', 'starting'].includes(s.status) || Object.keys(record(s.id).pending).length) ? { ...s, agent: record(s.id) } : s);
    const status = () => structuredClone({ pid: 123, generation: 'synthetic-attention',
      normalTerminalVersion: 1, ...(preferences ? {settingsVersion: 1, sessionRenameVersion: 1, settings: settings()} : {}), sessions: rows(), lastSeq: 0,
      ...(runner ? { agentAttentionVersion: 1, agentAttention: { hasMore: false, pendingSessions: [...agents.values()].filter(a => Object.keys(a.pending).length).length,
        pendingAlerts: [...agents.values()].reduce((n, a) => n + Object.keys(a.pending).length, 0), durable: true, maxAgents: 128 } } : {}) });
    Object.defineProperty(document, 'hasFocus', { value: () => focused });
    Object.defineProperty(document, 'visibilityState', { get: () => visibility });
    const forbidden = (name: string): never => {
      unexpected.push(name); throw new Error(`Forbidden fixture boundary: ${name}`);
    };
    w.Notification = class {
      static permission = 'default';
      static requestPermission() { return forbidden('Notification.requestPermission'); }
      constructor(...args: any[]) { notifications.push(args); forbidden('Notification'); }
    };
    w.attentionFixture = {
      badges, unexpected, calls, resizes, notifications,
      // No focus event: the regression happens while the window is ALREADY focused.
      focus(value: boolean) { focused = value; },
      focusEvent(value: boolean) { focused = value; window.dispatchEvent(new Event(value ? 'focus' : 'blur')); },
      visibilityEvent(value: string) { visibility = value; document.dispatchEvent(new Event('visibilitychange')); },
      marks,
      state(id: string, value: string) {
        const session = sessions.find(s => s.id === id);
        if (runner && ['running', 'starting'].includes(session.status) && ['exited', 'stopped', 'failed'].includes(value)) {
          const a = record(id); agents.set(id, { ...a, alertSeq: a.alertSeq + 1, pending: { ...a.pending, ended: { seq: a.alertSeq + 1 } } });
        }
        session.status = value;
      },
      history(id: string, state: string, reason: string) { sessions.find(s => s.id === id).detail = {terminalStream: {history: {state, reason, durableFrame: 1, lastFrame: 2}}}; },
      pending(value: number) { pending = value; },
      snapshot() { return structuredClone({ sessions, evidence, permissionReads, statusReads, focused, pending }); },
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      async invoke(cmd: string, args: any) {
        if (cmd === 'connect_runner') return { dataDir: '/synthetic', socket: '/synthetic.sock', status: status(), smoke: true };
        if (cmd === 'probe_tools') return [];
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'plugin:event|unlisten') return;
        if (cmd === 'record_ui_evidence') { evidence = args.payload; return; }
        if (cmd === 'plugin:window|set_badge_count') { badges.push(args.value); return; }
        if (cmd === 'runner_request') {
          calls.push(args.op);
          if (preferences && args.op === 'get_settings') return {ok: true, result: settings()};
          if (preferences && args.op === 'set_settings') { maxConcurrentSessions = args.args.maxConcurrentSessions; return {ok: true, result: settings()}; }
          if (preferences && args.op === 'rename_session') { const session = sessions.find(s => s.id === args.args.id); session.title = args.args.title; return {ok: true, result: structuredClone(session)}; }
          if (args.op === 'status') { statusReads++; return { ok: true, result: status() }; }
          if (runner && args.op === 'mark_seen') {
            marks.push(structuredClone(args.args.items));
            const items = args.args.items.map((item: any) => {
              const a = record(item.id); const seen = Math.max(a.seenSeq, Math.min(item.through, a.alertSeq));
              const next = { ...a, seenSeq: seen, pending: Object.fromEntries(Object.entries(a.pending).filter(([, p]: any) => p.seq > seen)) };
              agents.set(item.id, next); return { id: item.id, agent: next };
            });
            return { ok: true, result: { items, durable: true } };
          }
          if (args.op === 'events') return { ok: true, result: { events: [], lastSeq: 0, hasMore: false } };
          if (args.op === 'telemetry') return { ok: true, result: {} };
          if (args.op === 'resize') {
            resizes.push(structuredClone(args.args));
            return { ok: true, result: { rows: args.args.rows, cols: args.args.cols } };
          }
          if (args.op === 'codex_state' && structured && args.args.id === 'permissions') {
            permissionReads++;
            return { ok: true, result: { sessionId: 'permissions', generation: 1, status: 'running',
              nativeThreadId: 'synthetic', turns: [], pendingRequestCount: pending,
              requests: Array.from({ length: pending }, (_, i) => ({ id: `p${i}`, generation: 1,
                status: 'pending', turnId: 't', attemptId: 'a', method: 'item/commandExecution/requestApproval' })) } };
          }
        }
        // Includes stop/release/interrupt/input, permission decisions, and all native permission APIs.
        return forbidden(`${cmd}:${args?.op ?? ''}`);
      },
      transformCallback() { return 1; }, unregisterCallback() {},
    };
  }, { structured, preferences, runner });
}

async function counts(page: Page, total: number, unseen: number) {
  await page.waitForFunction(({ total, unseen }) => {
    const header = document.querySelector<HTMLElement>('#session-alerts')!;
    const banner = document.querySelector<HTMLElement>('#attention-banner')!;
    return document.querySelector('#attention-count')?.textContent === `${total} ${total === 1 ? 'aviso' : 'avisos'}`
      && header.hidden === (total === 0)
      && header.dataset.total === String(total) && header.dataset.unread === String(unseen)
      && document.querySelector<HTMLElement>('#session-alerts-count')!.hidden === (unseen === 0)
      // Since 1.4 the alert list is the bell's popover: shown only while open and non-empty.
      && banner.hidden === (header.getAttribute('aria-expanded') !== 'true' || total === 0);
  }, { total, unseen });
  assert.equal(await page.title(), unseen ? `(${unseen}) Avisos · Jauría` : 'Jauría');
  const dock = await page.evaluate(() => (window as any).attentionFixture.badges.at(-1) ?? 0);
  assert.equal(dock, unseen, `Dock and header must agree (${total} total, ${unseen} new)`);
}

async function transition(page: Page, id: string, status: string) {
  await page.evaluate(({ id, status }) => (window as any).attentionFixture.state(id, status), { id, status });
  await page.waitForFunction(({ id, status }) =>
    (window as any).attentionFixture.snapshot().evidence?.sessions.some((s: any) => s.id === id && s.status === status), { id, status });
}

async function geometry(page: Page) {
  // Allow the production ResizeObserver debounce and evidence cadence to settle.
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    // No message rail since 1.4: the fixed chrome is the top bar, the pane heading and the status bar.
    const box = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const terminal = (window as any).attentionFixture.snapshot().evidence.sessions.find((s: any) => s.id === 'foreground');
    return { chrome: { top: box('.workbench-header'), heading: box('.pane-heading'), status: box('.status-bar') }, rows: terminal.rows, cols: terminal.cols };
  });
}

test('real browser: attention totals, unseen header and Dock stay consistent', {
  skip: process.env.ATTENTION_CONSISTENCY_BROWSER !== '1', timeout: 90000,
}, async t => {
  const { chromium, webkit } = await import('playwright');
  const { createServer } = await import('vite');
  const engine = process.env.ENGINE ?? 'chrome';
  assert.ok(['chrome', 'chromium', 'webkit'].includes(engine), `Unsupported ENGINE: ${engine}`);
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  try {
    const browser = await (engine === 'webkit' ? webkit.launch({ headless: true })
      : chromium.launch({ headless: true, channel: 'chrome' }));
    try {
      async function fixture(run: (page: Page) => Promise<void>, structured = false, preferences = false, runner = false) {
        const context = await browser.newContext({ viewport: { width: 1220, height: 800 } });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(8000);
          const errors: string[] = [];
          page.on('pageerror', error => errors.push(error.message));
          // Everything beyond the local dev server is forbidden, including network providers.
          await context.route('**/*', route => new URL(route.request().url()).origin === new URL(server.resolvedUrls!.local[0]).origin
            ? route.continue() : route.abort());
          await installMock(page, structured, preferences, runner);
          await page.goto(server.resolvedUrls!.local[0]);
          await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado'
            && (window as any).attentionFixture.snapshot().evidence?.sessions.some((s: any) => s.id === 'foreground' && s.rows > 2));
          await counts(page, 1, 0); // Historical failure starts seen, never erased.
          try { await run(page); }
          finally {
            assert.deepEqual(await page.evaluate(() => (window as any).attentionFixture.unexpected), [], 'only observation RPCs allowed');
            assert.deepEqual(await page.evaluate(() => (window as any).attentionFixture.notifications), [], 'native notifications remain disabled');
            assert.deepEqual(errors, [], 'no browser errors');
          }
        } finally { await context.close(); }
      }

      await t.test('old seen Codex failure + unseen background Claude stop = two total, one new; viewing consumes only end activity', async () => {
        await fixture(async page => {
          const before = await geometry(page);
          assert.deepEqual([before.chrome.top.height, before.chrome.heading.height, before.chrome.status.height], [42, 32, 28]);
          await transition(page, 'background', 'stopped'); // Simulated runner result, never send stop.
          await counts(page, 2, 1);
          assert.deepEqual(await geometry(page), before, 'attention must not resize the fixed chrome or fitted terminal');
          await page.locator('#attention-filter').click(); // Sidebar list of sessions with alerts.
          const rows = page.locator('#session-list .session-item');
          assert.equal(await rows.count(), 2);
          assert.equal(await rows.filter({ hasText: 'Codex historical failure' }).getAttribute('data-unseen'), 'false');
          const ended = rows.filter({ hasText: 'Claude background' });
          assert.equal(await ended.getAttribute('data-unseen'), 'true');
          assert.match(await ended.textContent() ?? '', /El proceso terminó/);
          await ended.click();
          await counts(page, 1, 0);
          assert.equal(await rows.count(), 1);
          assert.match(await rows.textContent() ?? '', /Codex historical failure.*Visto.*Interrumpida · No llegó a iniciarse/s);
          const states = await page.evaluate(() => (window as any).attentionFixture.snapshot().sessions);
          assert.equal(states.find((s: any) => s.id === 'old-failed').status, 'failed');
          assert.equal(states.find((s: any) => s.id === 'background').status, 'stopped');
        });
      });

      await t.test('runner mode: the same totals and Dock; the end comes from the runner and opening it sends mark_seen', async () => {
        await fixture(async page => {
          await transition(page, 'background', 'stopped');
          await counts(page, 2, 1);
          await page.locator('#attention-filter').click();
          const ended = page.locator('#session-list .session-item').filter({ hasText: 'Claude background' });
          assert.equal(await ended.getAttribute('data-unseen'), 'true');
          assert.match(await ended.textContent() ?? '', /El proceso terminó/);
          await ended.click();
          await counts(page, 1, 0);
          assert.deepEqual(await page.evaluate(() => (window as any).attentionFixture.marks), [[{ id: 'background', epoch: 5, through: 1 }]]);
          await page.waitForTimeout(1300);
          await counts(page, 1, 0); // The runner confirmed it: a later status never resurrects the end.
        }, false, false, true);
      });

      await t.test('already focused foreground end has no Dock badge, transient row, or phantom alert after leaving', async () => {
        await fixture(async page => {
          const before = await geometry(page);
          const badgeStart = await page.evaluate(() => (window as any).attentionFixture.badges.length);
          await transition(page, 'foreground', 'exited'); // No focus event, click or mark-seen after end.
          const dock = await page.evaluate(() => (window as any).attentionFixture.badges.at(-1) ?? 0);
          assert.equal(dock, 0, 'already-attended end: header is quiet, Dock must also be clear');
          await counts(page, 1, 0);
          // The visible process ending also changes its lifecycle controls. Only
          // the fixed chrome must stay fixed here; the background-end case above
          // isolates attention and checks fitted terminal rows/columns as well.
          assert.deepEqual((await geometry(page)).chrome, before.chrome);
          await page.locator('#attention-filter').click(); // Sidebar list of sessions with alerts.
          assert.equal(await page.locator('#session-list .session-item').count(), 1, 'attended transient must not remain listed');
          await page.locator('[data-filter="open"]').click();
          await page.locator('#session-list .session-item').filter({ hasText: 'Claude background' }).click();
          await page.waitForTimeout(1300); // A further status poll must not resurrect the end signal.
          await counts(page, 1, 0);
          assert.deepEqual(await page.evaluate(start => (window as any).attentionFixture.badges.slice(start).filter((n: number) => n > 0), badgeStart), []);
        });
      });

      await t.test('active failure remains persistent while attended; leaving makes it new; mark-seen retires seen failures (1.4.0) and preserves custody', async () => {
        await fixture(async page => {
          await transition(page, 'foreground', 'failed');
          await counts(page, 2, 0);
          await page.locator('#attention-filter').click(); // Sidebar list of sessions with alerts.
          const failed = page.locator('#session-list .session-item').filter({ hasText: 'Claude foreground' });
          assert.match(await failed.textContent() ?? '', /Interrumpida · No llegó a iniciarse/);
          assert.doesNotMatch(await failed.textContent() ?? '', /El proceso terminó/);
          await page.locator('[data-filter="open"]').click();
          await page.locator('#session-list .session-item').filter({ hasText: 'Claude background' }).click();
          await counts(page, 2, 1);
          await transition(page, 'background', 'needs_attention');
          await counts(page, 3, 1); // Custody is attended; only the background failure is new.
          await page.locator('#session-alerts').click();
          await page.locator('#see-attention').click();
          // 1.4.0: seen interruptions and failures leave the alerts (they stay in Interrumpidas); custody in doubt stays.
          await counts(page, 1, 0);
          await page.locator('#attention-filter').click(); // Sidebar list of sessions with alerts.
          assert.equal(await page.locator('#session-list .session-item').count(), 1);
          assert.match(await page.locator('#session-list').textContent() ?? '', /custodia/);
          const states = await page.evaluate(() => (window as any).attentionFixture.snapshot().sessions);
          assert.equal(states.find((s: any) => s.id === 'foreground').status, 'failed');
          assert.equal(states.find((s: any) => s.id === 'background').status, 'needs_attention');
        });
      });

      await t.test('mark-seen acknowledges pending permissions without approval or release', async () => {
        await fixture(async page => {
          await page.waitForFunction(() => (window as any).attentionFixture.snapshot().permissionReads > 0);
          await page.evaluate(() => (window as any).attentionFixture.pending(2));
          await counts(page, 2, 1);
          await page.locator('#session-alerts').click();
          await page.locator('#see-attention').click();
          // 1.4.0: the seen historical failure leaves the alerts; the pending permissions stay, seen.
          await counts(page, 1, 0);
          await page.locator('#attention-filter').click(); // Sidebar list of sessions with alerts.
          assert.match(await page.locator('#session-list').textContent() ?? '', /Visto.*2 permisos pendientes/s);
          const reads = await page.evaluate(() => (window as any).attentionFixture.snapshot().permissionReads);
          await page.waitForFunction(n => (window as any).attentionFixture.snapshot().permissionReads > n, reads);
          await counts(page, 1, 0);
          assert.equal(await page.evaluate(() => (window as any).attentionFixture.snapshot().pending), 2);
        }, true);
      });

      await t.test('real settings/rename clicks preserve terminal, separate history and keep local quota informational', async () => {
        await fixture(async page => {
          const pane = page.locator('.pane').first();
          const before = await geometry(page);
          assert.equal(await page.locator('#open-diagnostics').count(), 0);
          await page.locator('#open-settings').click();
          await page.getByLabel('Máximo de sesiones simultáneas').selectOption('4');
          await page.waitForFunction(() => document.querySelector('#capacity')?.textContent?.includes('de 4'));
          await page.getByRole('button', {name: 'Cerrar', exact: true}).click();
          await pane.locator('.pane-menu > summary').click();
          await pane.locator('[data-action=rename]').click();
          await page.getByLabel('Nombre de la sesión').fill('Claude Code');
          await page.getByRole('button', {name: 'Guardar nombre', exact: true}).click();
          await page.waitForFunction(() => !document.querySelector('dialog[open]'));
          assert.equal(await pane.locator('.pane-session-name').textContent(), 'Claude Code');
          assert.deepEqual(await geometry(page), before, 'dialogs and rename preserve fitted terminal geometry');
          await pane.locator('.pane-session-button').click();
          assert.deepEqual(await pane.locator('.session-picker [role="group"]').evaluateAll(groups => groups.map(g => ({label: g.querySelector('.session-picker-group')?.textContent, count: g.querySelectorAll('[role="option"]').length}))), [
            // 1.4.0: no Historial group; the old Codex-in-terminal failure cannot be continued, so it is not offered.
            {label: 'Abiertas', count: 2},
          ]);
          assert.equal(await pane.locator('.session-picker [role="option"][aria-selected="true"]').textContent().then(t => t?.includes('Claude Code')), true);
          await page.keyboard.press('Escape');
          assert.deepEqual(await geometry(page), before, 'the session picker preserves fitted terminal geometry');
          await page.evaluate(() => (window as any).attentionFixture.history('foreground', 'limited', 'quota'));
          await page.waitForTimeout(1300);
          assert.equal(await pane.locator('.session-state').textContent(), 'Abierta');
          assert.equal(await page.locator('#notice').isVisible(), false);
          await counts(page, 1, 0);
          // The local history note moved from the retired Información panel to the pane menu.
          await pane.locator('.pane-menu > summary').click();
          assert.match(await pane.locator('.pane-menu-note').textContent() ?? '', /Historial local parcial.*continúa normalmente.*No limita/s);
          await page.keyboard.press('Escape');
          assert.deepEqual(await geometry(page), before, 'the pane menu preserves fitted terminal geometry');
          if (process.env.JAURIA_QA_SCREENSHOTS) {
            const {mkdir} = await import('node:fs/promises');
            await mkdir(process.env.JAURIA_QA_SCREENSHOTS, {recursive: true});
            await page.screenshot({path: `${process.env.JAURIA_QA_SCREENSHOTS}/${engine}-sesion.png`});
            for (const theme of ['light', 'dark']) {
              await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
              await page.locator('.session-filters').screenshot({animations: 'disabled', path: `${process.env.JAURIA_QA_SCREENSHOTS}/${engine}-tabs-${theme}-abiertas.png`});
              await page.locator('[data-filter=closed]').click();
              await page.locator('.session-filters').screenshot({animations: 'disabled', path: `${process.env.JAURIA_QA_SCREENSHOTS}/${engine}-tabs-${theme}-historial.png`});
              await page.locator('[data-filter=open]').click();
            }
            await page.evaluate(() => { document.documentElement.dataset.theme = 'system'; });
            await page.locator('#open-settings').click();
            await page.waitForFunction(() => document.querySelector('dialog.settings-dialog')?.getAttribute('aria-busy') === 'false');
            await page.screenshot({path: `${process.env.JAURIA_QA_SCREENSHOTS}/${engine}-configuracion.png`});
          }
          assert.equal(await page.evaluate(() => (window as any).attentionFixture.calls.filter((op: string) => op === 'rename_session').length), 1);
        }, false, true);
      });

      await t.test('an end behind settings stays new until the dialog closes', async () => {
        await fixture(async page => {
          await page.locator('#open-settings').click();
          await transition(page, 'foreground', 'exited');
          await counts(page, 2, 1);
          await page.getByRole('button', {name: 'Cerrar', exact: true}).click();
          await counts(page, 1, 0);
        }, false, true);
      });

      await t.test('focus, blur and visibility immediately refresh persistent unread state without acknowledgement', async () => {
        await fixture(async page => {
          await transition(page, 'foreground', 'failed');
          await counts(page, 2, 0);
          for (const [event, value, unseen] of [
            ['focusEvent', false, 1], ['focusEvent', true, 0],
            ['visibilityEvent', 'hidden', 1], ['visibilityEvent', 'visible', 0],
            ['focusEvent', false, 1], ['focusEvent', true, 0],
          ] as const) {
            // Dispatch and inspect within one browser task: a periodic status poll
            // cannot mask a missing event handler. Drain only badge-write microtasks.
            const result = await page.evaluate(async ({ event, value }) => {
              const f = (window as any).attentionFixture;
              const reads = f.snapshot().statusReads;
              f[event](value);
              for (let i = 0; i < 8; i++) await Promise.resolve();
              return { header: document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread,
                dock: f.badges.at(-1) ?? 0, reads, after: f.snapshot().statusReads,
                state: f.snapshot().sessions.find((s: any) => s.id === 'foreground').status };
            }, { event, value });
            assert.equal(result.header, String(unseen), `${event}(${value}): immediate header`);
            assert.equal(result.dock, unseen, `${event}(${value}): immediate Dock`);
            assert.equal(result.after, result.reads, 'event refresh does not depend on a status poll');
            assert.equal(result.state, 'failed', 'focus changes must not resolve lifecycle state');
          }
          // Blur re-exposes the same unseen failure, proving focus never marked it seen.
          await page.evaluate(() => (window as any).attentionFixture.focusEvent(false));
          await counts(page, 2, 1);
        });
      });
    } finally { await browser.close(); }
  } finally { await server.close(); }
});
