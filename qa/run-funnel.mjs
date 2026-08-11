#!/usr/bin/env node
/* =============================================================================
   СТЕНД ТЕСТИРОВЩИКА ОСТРОВА - прогон онбординг-воронки в реальном браузере.

   Что делает: поднимает статику public/ на свободном порту, открывает /island
   в headless Chromium, перехватывает вызовы к боевому API (чтобы тест был
   детерминированным и не писал мусор в прод), проводит игрока по всей воронке
   и проверяет каждый шаг фактом - что на экране, что в localStorage,
   что улетело на сервер.

   Запуск:
     node qa/run-funnel.mjs                 # все сценарии
     node qa/run-funnel.mjs --only=LVL      # только проверки с префиксом LVL
     node qa/run-funnel.mjs --headed        # с окном (для глаз)
     node qa/run-funnel.mjs --slow          # без ускорения таймеров (как у живого игрока)

   Коды выхода: 0 - все проверки прошли, 1 - есть падения.
   ============================================================================= */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// playwright лежит в глобальном пакете @playwright/mcp - берём оттуда
function loadPlaywright() {
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

// playwright бывает собран под другой номер Chromium, чем лежит в кеше.
// Берём любую подходящую сборку из кеша, иначе - установленный Chrome. Ничего не докачиваем.
function pickExecutable(headed) {
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

const ARGS = process.argv.slice(2);
const ONLY = (ARGS.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const HEADED = ARGS.includes('--headed');
const SLOW = ARGS.includes('--slow');

const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.png':'image/png',
  '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.mp4':'video/mp4', '.ico':'image/x-icon' };

function startServer() {
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
const results = [];
let scenarioName = '';
function check(id, title, pass, detail) {
  results.push({ id, title, pass: !!pass, detail: detail || '', scenario: scenarioName });
  const mark = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark} ${id}  ${title}${pass ? '' : '\n        └─ ' + (detail || 'нет деталей')}`);
}

/* ── подготовка страницы ───────────────────────────────────────────────────── */
const API_HOST = 'https://ek-pvp.13-140-178-130.sslip.io';

async function newPage(browser, { content = null, viewport = { width: 390, height: 844 } } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const captured = { quizResults: [], chatCalls: [], consoleErrors: [], pageErrors: [] };

  // озвучка детерминирована: onend приходит сразу, тест не ждёт живой TTS
  if (!SLOW) {
    await ctx.addInitScript(() => {
      // window.speechSynthesis - геттер прототипа, простым присваиванием его не подменить
      const stub = {
        speak(u) { setTimeout(() => { try { u.onend && u.onend({}); } catch (e) {} }, 60); },
        cancel() {}, pause() {}, resume() {}, getVoices: () => [],
        onvoiceschanged: null, speaking: false, pending: false, paused: false
      };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => stub });
    });
  }

  // весь боевой API - в заглушки, прод не трогаем
  await ctx.route(`${API_HOST}/**`, async route => {
    const req = route.request();
    const url = req.url();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/api/island/content')) return json({ data: content || {}, updatedAt: null });
    if (url.includes('/api/island/quiz-result')) {
      try { captured.quizResults.push(JSON.parse(req.postData() || '{}')); } catch { captured.quizResults.push(null); }
      return json({ ok: true });
    }
    if (url.includes('/api/island/chat')) {
      try { captured.chatCalls.push(JSON.parse(req.postData() || '{}')); } catch {}
      return json({ reply: 'Понял тебя. Возвращаемся к шагу.' });
    }
    return json({ ok: true });
  });

  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') captured.consoleErrors.push(m.text()); });
  page.on('pageerror', e => captured.pageErrors.push(String(e && e.message || e)));
  page.captured = captured;
  page.ctx = ctx;
  return page;
}

/* ── помощники по экрану ───────────────────────────────────────────────────── */
const chipTexts = page => page.$$eval('#onbQuick .chip', els => els.map(e => e.textContent.trim()));
const lastIn = page => page.$$eval('#chatScroll .row.in .bubble', els =>
  els.length ? els[els.length - 1].innerText.trim() : '');
const allText = page => page.$eval('#chatScroll', el => el.innerText);
const state = page => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ek_island_v1') || '{}'); } catch { return {}; } });

async function waitChip(page, rx, timeout = 12000) {
  await page.waitForFunction(r => {
    const re = new RegExp(r);
    return [...document.querySelectorAll('#onbQuick .chip')].some(c => re.test(c.textContent))
      && !document.querySelector('#onbQuick').classList.contains('hidden');
  }, rx.source || rx, { timeout });
}
async function clickChip(page, rx) {
  await waitChip(page, rx);
  const chips = await page.$$('#onbQuick .chip');
  for (const c of chips) {
    const t = (await c.textContent() || '').trim();
    if ((rx.source ? new RegExp(rx.source) : new RegExp(rx)).test(t)) { await c.click(); return t; }
  }
  throw new Error('чип не найден: ' + rx);
}
async function waitBubble(page, rx, timeout = 12000) {
  await page.waitForFunction(r => new RegExp(r).test(document.querySelector('#chatScroll').innerText),
    rx.source || rx, { timeout });
}
// проходим кружок Романа: тапаем и ждём следующего шага
async function passCircle(page) {
  await page.waitForSelector('#chatScroll .vcircle', { timeout: 12000 });
  const circles = await page.$$('#chatScroll .vcircle');
  await circles[circles.length - 1].click();
}

/* ── сценарий: полный проход воронки ───────────────────────────────────────── */
async function runFunnel(browser, opts) {
  const { name, quizPicks, expectTrack, expectLevel, content = null } = opts;
  scenarioName = name;
  console.log(`\n\x1b[36m▶ Сценарий: ${name}\x1b[0m`);
  const page = await newPage(browser, { content });
  const P = opts.prefix || 'FUN';
  await page.goto(`http://127.0.0.1:${PORT}/island/index.html`, { waitUntil: 'domcontentloaded' });

  // 0. экран разрешений
  const permVisible = await page.waitForSelector('#s-perm.on', { timeout: 8000 }).then(() => true).catch(() => false);
  check(`${P}-01`, 'Экран разрешений показан до входа', permVisible, 'не появился #s-perm');
  if (permVisible) await page.click('#permSkip');

  check(`${P}-02`, 'Открылся онбординг-чат',
    await page.waitForSelector('#s-onb.on', { timeout: 8000 }).then(() => true).catch(() => false));

  // 1. кружок знакомства
  const c1 = await page.waitForSelector('#chatScroll .vcircle', { timeout: 10000 }).then(() => true).catch(() => false);
  check(`${P}-03`, 'Кружок 1 (знакомство) появился в чате', c1);
  await passCircle(page);

  // 2. имя
  const nameAsked = await waitBubble(page, /Как тебя зовут/i).then(() => true).catch(() => false);
  check(`${P}-04`, 'После кружка 1 спрашивают имя', nameAsked, await lastIn(page));
  const ph = await page.$eval('#onbInput', el => el.placeholder);
  check(`${P}-05`, 'Подсказка в поле ввода зовёт написать имя', /имя/i.test(ph), `placeholder="${ph}"`);
  await page.fill('#onbInput', 'Тестер');
  await page.press('#onbInput', 'Enter');

  // 3. цель
  const goalAsked = await waitBubble(page, /Для чего ты хочешь изучать английский/i).then(() => true).catch(() => false);
  check(`${P}-06`, 'После имени спрашивают цель', goalAsked, await lastIn(page));
  const st1 = await state(page);
  check(`${P}-07`, 'Имя сохранено в состоянии игры', st1.name === 'Тестер', `S.name=${JSON.stringify(st1.name)}`);
  const goalChips = await chipTexts(page);
  check(`${P}-08`, 'Показаны 5 вариантов цели', goalChips.length === 5, `варианты: ${goalChips.join(' | ')}`);
  await clickChip(page, /Путешеств/i);

  // 4. время в день
  const timeAsked = await waitBubble(page, /Сколько времени/i).then(() => true).catch(() => false);
  check(`${P}-09`, 'После цели спрашивают время в день', timeAsked, await lastIn(page));
  const timeChips = await chipTexts(page);
  check(`${P}-10`, 'Показаны 3 варианта времени', timeChips.length === 3, `варианты: ${timeChips.join(' | ')}`);
  await clickChip(page, /10 минут/i);

  // 5. кружок про персонажа
  const c2 = await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 12000 })
    .then(() => true).catch(() => false);
  check(`${P}-11`, 'Кружок 2 (как всё устроено) появился', c2);
  await passCircle(page);

  // 6. опыт
  const expAsked = await waitBubble(page, /изучал английский раньше/i).then(() => true).catch(() => false);
  check(`${P}-12`, 'После кружка 2 спрашивают про опыт', expAsked, await lastIn(page));
  const expChips = await chipTexts(page);
  check(`${P}-13`, 'Показаны 3 варианта опыта', expChips.length === 3, `варианты: ${expChips.join(' | ')}`);
  await clickChip(page, /Немного изучал/i);

  // 7. кружок про тест
  const c3 = await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 3, null, { timeout: 12000 })
    .then(() => true).catch(() => false);
  check(`${P}-14`, 'Кружок 3 (объяснение теста) появился', c3);
  await passCircle(page);

  // 8. тест
  const q1 = await waitBubble(page, /Вопрос 1 из 6/).then(() => true).catch(() => false);
  check(`${P}-15`, 'Тест начался с «Вопрос 1 из 6»', q1, await lastIn(page));
  const hasListen = await page.$('#chatScroll .qz-listen') !== null;
  check(`${P}-16`, 'У вопроса есть кнопка «Послушать»', hasListen);
  const hintShown = /не экзамен/i.test(await allText(page));
  check(`${P}-17`, 'Показана подсказка «это не экзамен»', hintShown);

  for (let i = 0; i < quizPicks.length; i++) {
    await page.waitForFunction(n => new RegExp('Вопрос ' + n + ' из').test(document.querySelector('#chatScroll').innerText),
      i + 1, { timeout: 12000 });
    const opts = await chipTexts(page);
    if (i === 0) check(`${P}-18`, 'У вопроса ровно 3 варианта ответа', opts.length === 3, `вариантов: ${opts.length}`);
    const chips = await page.$$('#onbQuick .chip');
    await chips[quizPicks[i]].click();
  }

  // 9. итог
  const routeShown = await waitBubble(page, /(Basic|Advanced)/).then(() => true).catch(() => false);
  check(`${P}-19`, 'Показан итоговый маршрут', routeShown, await lastIn(page));
  const resultText = await lastIn(page);
  check(`${P}-20`, `Маршрут назван верно (${expectTrack})`,
    new RegExp(expectTrack, 'i').test(resultText), `в сообщении: "${resultText}"`);
  check(`${P}-21`, 'Имя игрока подставлено вместо {name}',
    resultText.includes('Тестер') && !resultText.includes('{name}'), `в сообщении: "${resultText}"`);

  const st2 = await state(page);
  check(`${P}-22`, `Трек в состоянии = ${expectTrack}`, st2.track === expectTrack, `S.track=${st2.track}`);
  check(`${P}-23`, `Уровень фраз = ${expectLevel}`, st2.level === expectLevel, `S.level=${st2.level}`);
  check(`${P}-24`, 'Цель и время сохранены', !!st2.goal && !!st2.daily, `goal=${st2.goal} daily=${st2.daily}`);

  // 10. аналитика улетела
  await page.waitForTimeout(400);
  const sent = page.captured.quizResults[0];
  check(`${P}-25`, 'Результат теста отправлен на сервер', !!sent, 'POST /api/island/quiz-result не пришёл');
  if (sent) {
    check(`${P}-26`, 'В отправке 6 ответов', Array.isArray(sent.answers) && sent.answers.length === 6,
      `answers=${JSON.stringify(sent.answers)}`);
    check(`${P}-27`, 'В отправке верный трек и уровень', sent.track === expectTrack && sent.level === expectLevel,
      `track=${sent.track} level=${sent.level}`);
    check(`${P}-28`, 'В отправке имя, цель, время, опыт',
      sent.player === 'Тестер' && !!sent.goal && !!sent.time && !!sent.exp,
      JSON.stringify({ player: sent.player, goal: sent.goal, time: sent.time, exp: sent.exp }));
  }

  // 11. START ведёт на карту
  const startBtn = await page.waitForSelector('#bigStart', { timeout: 10000 }).then(() => true).catch(() => false);
  check(`${P}-29`, 'Кнопка START появилась', startBtn);
  if (startBtn) {
    await page.click('#bigStart');
    const onMap = await page.waitForSelector('#s-map.on', { timeout: 8000 }).then(() => true).catch(() => false);
    check(`${P}-30`, 'START открывает карту острова', onMap);
  }

  // 12. гигиена
  check(`${P}-31`, 'Нет ошибок в консоли браузера', page.captured.consoleErrors.length === 0,
    page.captured.consoleErrors.slice(0, 3).join(' | '));
  check(`${P}-32`, 'Нет необработанных исключений', page.captured.pageErrors.length === 0,
    page.captured.pageErrors.slice(0, 3).join(' | '));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${P}-33`, 'Нет горизонтальной прокрутки', overflow <= 1, `перелив ${overflow}px`);

  await page.ctx.close();
}

/* ── сценарий: устойчивость воронки ────────────────────────────────────────── */
async function runRobustness(browser) {
  scenarioName = 'Устойчивость';
  console.log(`\n\x1b[36m▶ Сценарий: устойчивость воронки\x1b[0m`);
  const page = await newPage(browser);
  await page.goto(`http://127.0.0.1:${PORT}/island/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-perm.on', { timeout: 8000 }).catch(() => {});
  await page.click('#permSkip').catch(() => {});
  await page.waitForSelector('#chatScroll .vcircle', { timeout: 10000 });
  await passCircle(page);
  await waitBubble(page, /Как тебя зовут/i);

  // имя из пробелов не должно проходить
  await page.fill('#onbInput', '   ');
  await page.press('#onbInput', 'Enter');
  await page.waitForTimeout(500);
  const stillName = /Как тебя зовут/i.test(await lastIn(page));
  check('ROB-01', 'Пустое имя не проглатывается', stillName, `последняя реплика: "${await lastIn(page)}"`);

  await page.fill('#onbInput', 'Женя');
  await page.press('#onbInput', 'Enter');
  await waitBubble(page, /Для чего ты хочешь/i);

  // свободный текст на шаге цели: отвечает живой Роман и возвращает кнопки
  await page.fill('#onbInput', 'а это бесплатно вообще');
  await page.press('#onbInput', 'Enter');
  const aiReplied = await waitBubble(page, /Возвращаемся к шагу/).then(() => true).catch(() => false);
  check('ROB-02', 'Свободный вопрос уходит живому Роману', aiReplied, 'ответ AI не появился');
  const chatCall = page.captured.chatCalls[0];
  check('ROB-03', 'В AI уходит верный шаг воронки', chatCall && chatCall.step === 'goal',
    `step=${chatCall && chatCall.step}`);
  const chipsBack = await page.waitForFunction(
    () => !document.querySelector('#onbQuick').classList.contains('hidden')
      && document.querySelectorAll('#onbQuick .chip').length >= 3, null, { timeout: 8000 })
    .then(() => true).catch(() => false);
  check('ROB-04', 'После ответа AI кнопки шага вернулись', chipsBack);

  // текстом словами вместо кнопки
  await page.fill('#onbInput', 'работа');
  await page.press('#onbInput', 'Enter');
  const moved = await waitBubble(page, /Сколько времени/i).then(() => true).catch(() => false);
  check('ROB-05', 'Ответ словами засчитывается как выбор варианта', moved, await lastIn(page));
  const st = await state(page);
  check('ROB-06', 'Выбор словами сохранён верным ключом', st.goalKey === 'work', `goalKey=${st.goalKey}`);

  await page.ctx.close();
}

/* ── сценарий: кружок не проигрался (нет звука / автоплей заблокирован) ────── */
async function runCircleFallback(browser) {
  scenarioName = 'Кружок не проигрался';
  console.log(`\n\x1b[36m▶ Сценарий: игрок не запустил кружок\x1b[0m`);
  const page = await newPage(browser);
  await page.goto(`http://127.0.0.1:${PORT}/island/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-perm.on', { timeout: 8000 }).catch(() => {});
  await page.click('#permSkip').catch(() => {});
  await page.waitForSelector('#chatScroll .vcircle', { timeout: 10000 });
  // НЕ тапаем кружок - ждём страховочную кнопку
  const fallback = await page.waitForFunction(
    () => [...document.querySelectorAll('#onbQuick .chip')].some(c => /Дальше/.test(c.textContent)),
    null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('FB-01', 'Появилась кнопка «Дальше», воронка не встала', fallback, 'кнопки нет за 20с');
  if (fallback) {
    await clickChip(page, /Дальше/);
    const asked = await waitBubble(page, /Как тебя зовут/i).then(() => true).catch(() => false);
    check('FB-02', 'Кнопка «Дальше» ведёт на следующий шаг', asked, await lastIn(page));
  }
  await page.ctx.close();
}

/* ── сценарий: контент Романа из админки перебивает дефолты ────────────────── */
async function runRomanContent(browser) {
  scenarioName = 'Контент из админки';
  console.log(`\n\x1b[36m▶ Сценарий: контент Романа поверх дефолтов\x1b[0m`);
  const custom = {
    circles: { c1: { who: 'Рома', text: 'Мой личный текст кружка. Поехали.', video: '' } },
    survey: { name: { ask: 'Как звать?', placeholder: 'Имя сюда' } },
    quiz: { hint: 'Просто ткни в вариант', startBtn: '🏝️ НА ОСТРОВ' }
  };
  const page = await newPage(browser, { content: custom });
  await page.goto(`http://127.0.0.1:${PORT}/island/island-not-exists`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.goto(`http://127.0.0.1:${PORT}/island/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-perm.on', { timeout: 8000 }).catch(() => {});
  await page.click('#permSkip').catch(() => {});
  await page.waitForSelector('#chatScroll .vcircle', { timeout: 10000 });
  await passCircle(page);
  const asked = await waitBubble(page, /Как звать\?/).then(() => true).catch(() => false);
  check('CNT-01', 'Правка вопроса из админки видна игроку', asked, await lastIn(page));
  const ph = await page.$eval('#onbInput', el => el.placeholder);
  check('CNT-02', 'Подсказка поля берётся из админки', ph === 'Имя сюда', `placeholder="${ph}"`);

  // Роман правил только подсказку и кнопку теста, вопросы не трогал - тест обязан остаться целым.
  // Проверяем поведением, а не заглядыванием внутрь: доходим до теста и до кнопки старта.
  await page.fill('#onbInput', 'Проверка');
  await page.press('#onbInput', 'Enter');
  await waitBubble(page, /Для чего ты хочешь/i);
  await clickChip(page, /Работа/i);
  await waitBubble(page, /Сколько времени/i);
  await clickChip(page, /5 минут/i);
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 12000 });
  await passCircle(page);
  await waitBubble(page, /изучал английский раньше/i);
  await clickChip(page, /с нуля/i);
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 3, null, { timeout: 12000 });
  await passCircle(page);

  const quizAlive = await waitBubble(page, /Вопрос 1 из 6/).then(() => true).catch(() => false);
  check('CNT-03', 'Вопросы теста уцелели при частичной правке контента', quizAlive, await lastIn(page));
  const customHint = /Просто ткни в вариант/.test(await allText(page));
  check('CNT-04', 'Своя подсказка к тесту показана', customHint);

  for (let i = 0; i < 6; i++) {
    await page.waitForFunction(n => new RegExp('Вопрос ' + n + ' из').test(document.querySelector('#chatScroll').innerText),
      i + 1, { timeout: 12000 });
    const chips = await page.$$('#onbQuick .chip');
    await chips[0].click();
  }
  const startLabel = await page.waitForSelector('#bigStart', { timeout: 10000 })
    .then(el => el.textContent()).catch(() => '');
  check('CNT-05', 'Своя надпись на кнопке старта', /НА ОСТРОВ/.test(startLabel || ''), `кнопка: "${startLabel}"`);
  await page.ctx.close();
}

/* ── запуск ────────────────────────────────────────────────────────────────── */
let PORT = 0;
(async () => {
  const { chromium } = loadPlaywright();
  const { srv, port } = await startServer();
  PORT = port;
  const exe = pickExecutable(HEADED);
  const browser = await chromium.launch({ headless: !HEADED, ...(exe ? { executablePath: exe } : {}) });
  console.log(`\x1b[1mСтенд Острова\x1b[0m  сервер :${port}  браузер ${HEADED ? 'с окном' : 'headless'}`
    + (exe ? `\n  движок: ${exe.replace(process.env.HOME || '', '~')}` : ''));

  try {
    const want = p => !ONLY || p.startsWith(ONLY) || ONLY === 'ALL';

    // маршрут Advanced: верны вопросы 3 и 4
    if (want('FUN') || want('LVL'))
      await runFunnel(browser, { name: 'Полная воронка, маршрут Advanced', prefix: 'FUN',
        quizPicks: [1, 1, 0, 1, 1, 1], expectTrack: 'advanced', expectLevel: 'advanced' });

    // Basic + фразы посложнее: верны 1 и 2, но не 3
    if (want('LVL'))
      await runFunnel(browser, { name: 'Маршрут Basic, уровень mid (верны 1-2, промах на 3)', prefix: 'LVL',
        quizPicks: [1, 1, 2, 1, 0, 0], expectTrack: 'basic', expectLevel: 'mid' });

    // Basic новичок: почти всё мимо
    if (want('LVL') || want('BEG'))
      await runFunnel(browser, { name: 'Маршрут Basic, уровень beginner (всё мимо)', prefix: 'BEG',
        quizPicks: [0, 0, 1, 0, 0, 0], expectTrack: 'basic', expectLevel: 'beginner' });

    // граница: верен 3, но промах на 4 - это ещё Basic
    if (want('EDGE'))
      await runFunnel(browser, { name: 'Граница: верен №3, промах №4 - остаётся Basic', prefix: 'EDGE',
        quizPicks: [0, 0, 0, 0, 1, 1], expectTrack: 'basic', expectLevel: 'beginner' });

    if (want('ROB')) await runRobustness(browser);
    if (want('FB')) await runCircleFallback(browser);
    if (want('CNT')) await runRomanContent(browser);
  } catch (e) {
    check('RUN-00', 'Стенд отработал без падений', false, String(e && e.stack || e));
  } finally {
    await browser.close();
    srv.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + '─'.repeat(64));
  console.log(`Проверок: ${results.length}   \x1b[32mпрошло ${results.length - failed.length}\x1b[0m   ` +
    (failed.length ? `\x1b[31mупало ${failed.length}\x1b[0m` : 'упало 0'));
  if (failed.length) {
    console.log('\nПадения:');
    failed.forEach(f => console.log(`  ✗ [${f.scenario}] ${f.id} ${f.title}\n      ${f.detail}`));
  }
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
