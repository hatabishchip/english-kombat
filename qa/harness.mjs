/* =============================================================================
   ОБЩАЯ ОСНАСТКА СТЕНДА - то, что нужно каждому набору проверок:
   статика на свободном порту, headless-браузер, журнал проверок,
   заглушки боевого API, помощники по экрану онбординга.

   Вынесено отдельно, чтобы новые наборы (qa/run-edge.mjs, qa/run-server.mjs,
   qa/run-admin.mjs) не копировали одно и то же и не трогали run-funnel.mjs.
   ============================================================================= */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const PUBLIC = path.join(ROOT, 'public');
export const API_HOST = 'https://ek-pvp.13-140-178-130.sslip.io';

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  try { candidates.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch {}
  candidates.push('/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules');
  for (const root of candidates) {
    for (const p of [path.join(root, '@playwright/mcp'), root]) {
      try { return require(require.resolve('playwright', { paths: [p] })); } catch {}
    }
  }
  try { return require('playwright'); } catch {}
  throw new Error('playwright не найден. Поставь: npm i -g playwright');
}

export function pickExecutable(headed) {
  const cache = path.join(process.env.HOME || '', 'Library/Caches/ms-playwright');
  const pick = (prefix, tail) => {
    if (!fs.existsSync(cache)) return null;
    const dirs = fs.readdirSync(cache).filter(d => d.startsWith(prefix))
      .sort((a, b) => (parseInt(b.split('-').pop(), 10) || 0) - (parseInt(a.split('-').pop(), 10) || 0));
    for (const d of dirs) {
      const p = path.join(cache, d, tail);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
  if (headed) {
    return pick('chromium-', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium')
      || (fs.existsSync('/Applications/Google Chrome.app') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
  }
  return pick('chromium_headless_shell-', 'chrome-headless-shell-mac-arm64/chrome-headless-shell')
    || pick('chromium-', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium')
    || (fs.existsSync('/Applications/Google Chrome.app') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.png':'image/png',
  '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.mp4':'video/mp4', '.ico':'image/x-icon' };

export function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/island' || rel === '/island/') rel = '/island/index.html';
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ── журнал проверок ───────────────────────────────────────────────────────── */
export const results = [];
let scenarioName = '';
export function scenario(name) {
  scenarioName = name;
  console.log(`\n\x1b[36m▶ Сценарий: ${name}\x1b[0m`);
}
export function check(id, title, pass, detail) {
  results.push({ id, title, pass: !!pass, detail: detail || '', scenario: scenarioName });
  const mark = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark} ${id}  ${title}${pass ? '' : '\n        └─ ' + (detail || 'нет деталей')}`);
}
export function report(file) {
  const failed = results.filter(r => !r.pass);
  console.log('\n' + '─'.repeat(64));
  console.log(`Проверок: ${results.length}   \x1b[32mпрошло ${results.length - failed.length}\x1b[0m   ` +
    (failed.length ? `\x1b[31mупало ${failed.length}\x1b[0m` : 'упало 0'));
  if (failed.length) {
    console.log('\nПадения:');
    failed.forEach(f => console.log(`  ✗ [${f.scenario}] ${f.id} ${f.title}\n      ${f.detail}`));
  }
  if (file) fs.writeFileSync(path.join(__dirname, file), JSON.stringify(results, null, 2));
  return failed.length;
}

/* ── страница с заглушенным боевым API ─────────────────────────────────────── */
export async function newPage(browser, opts = {}) {
  const { content = null, slow = false, statsBody = null, storage = null } = opts;
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const captured = { quizResults: [], chatCalls: [], consoleErrors: [], pageErrors: [], statsCalls: 0 };

  if (!slow) {
    await ctx.addInitScript(() => {
      const stub = {
        speak(u) { setTimeout(() => { try { u.onend && u.onend({}); } catch (e) {} }, 60); },
        cancel() {}, pause() {}, resume() {}, getVoices: () => [],
        onvoiceschanged: null, speaking: false, pending: false, paused: false
      };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => stub });
    });
  }
  if (storage) {
    await ctx.addInitScript(s => { try { localStorage.setItem('ek_island_v1', s); } catch (e) {} }, storage);
  }

  await ctx.route(`${API_HOST}/**`, async route => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/api/island/quiz-stats')) {
      captured.statsCalls++;
      if (statsBody === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"db"}' });
      return json(statsBody || { total: 0 });
    }
    if (url.includes('/api/island/content')) return json({ data: content || {}, updatedAt: null });
    if (url.includes('/api/island/quiz-result')) {
      try { captured.quizResults.push(JSON.parse(req.postData() || '{}')); } catch { captured.quizResults.push(null); }
      return json({ ok: true });
    }
    if (url.includes('/api/island/chat')) {
      try { captured.chatCalls.push(JSON.parse(req.postData() || '{}')); } catch {}
      return json({ reply: 'Понял тебя. Возвращаемся к шагу.' });
    }
    if (url.includes('/api/admin/login')) return json({ ok: true });
    return json({ ok: true });
  });

  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') captured.consoleErrors.push(m.text()); });
  page.on('pageerror', e => captured.pageErrors.push(String(e && e.message || e)));
  page.captured = captured;
  page.ctx = ctx;
  return page;
}

/* ── помощники по онбордингу ───────────────────────────────────────────────── */
export const chipTexts = page => page.$$eval('#onbQuick .chip', els => els.map(e => e.textContent.trim()));
export const lastIn = page => page.$$eval('#chatScroll .row.in .bubble', els =>
  els.length ? els[els.length - 1].innerText.trim() : '');
export const allText = page => page.$eval('#chatScroll', el => el.innerText);
export const state = page => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('ek_island_v1') || '{}'); } catch { return {}; }
});

export async function waitChip(page, rx, timeout = 12000) {
  await page.waitForFunction(r => {
    const re = new RegExp(r);
    return [...document.querySelectorAll('#onbQuick .chip')].some(c => re.test(c.textContent))
      && !document.querySelector('#onbQuick').classList.contains('hidden');
  }, rx.source || rx, { timeout });
}
export async function clickChip(page, rx) {
  await waitChip(page, rx);
  const chips = await page.$$('#onbQuick .chip');
  for (const c of chips) {
    const t = (await c.textContent() || '').trim();
    if ((rx.source ? new RegExp(rx.source) : new RegExp(rx)).test(t)) { await c.click(); return t; }
  }
  throw new Error('чип не найден: ' + rx);
}
export async function waitBubble(page, rx, timeout = 12000) {
  await page.waitForFunction(r => new RegExp(r).test(document.querySelector('#chatScroll').innerText),
    rx.source || rx, { timeout });
}
export async function passCircle(page) {
  await page.waitForSelector('#chatScroll .vcircle', { timeout: 12000 });
  const circles = await page.$$('#chatScroll .vcircle');
  await circles[circles.length - 1].click();
}
export async function openIsland(page, port) {
  await page.goto(`http://127.0.0.1:${port}/island/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-perm.on', { timeout: 8000 }).catch(() => {});
  await page.click('#permSkip').catch(() => {});
}
/* Дойти до конца воронки: имя -> цель -> время -> кружок2 -> опыт -> кружок3 -> тест.
   picks - индексы выбираемых вариантов теста. */
export async function walkFunnel(page, { name = 'Тестер', picks = [0, 0, 0, 0, 0, 0] } = {}) {
  await page.waitForSelector('#chatScroll .vcircle', { timeout: 12000 });
  await passCircle(page);
  await waitBubble(page, /Как тебя зовут|\?/i).catch(() => {});
  await page.waitForFunction(() => !!document.querySelector('#onbInput'), null, { timeout: 5000 });
  await page.fill('#onbInput', name);
  await page.press('#onbInput', 'Enter');
  await waitChip(page, /./);
  await (await page.$$('#onbQuick .chip'))[0].click();       // цель
  await waitChip(page, /./);
  await (await page.$$('#onbQuick .chip'))[0].click();       // время
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 12000 });
  await passCircle(page);
  await waitChip(page, /./);
  await (await page.$$('#onbQuick .chip'))[0].click();       // опыт
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 3, null, { timeout: 12000 });
  await passCircle(page);
  for (let i = 0; i < picks.length; i++) {
    await page.waitForFunction(n => new RegExp('Вопрос ' + n + ' из').test(document.querySelector('#chatScroll').innerText),
      i + 1, { timeout: 12000 });
    const chips = await page.$$('#onbQuick .chip');
    await chips[picks[i]].click();
  }
  await page.waitForSelector('#bigStart', { timeout: 12000 });
}
