#!/usr/bin/env node
/* =============================================================================
   WORMS-АРЕНА (public/island/worms.html), набор WRM.

   Появился 27.11.2026 после слов владельца: "микрофон должен был сам быть активным
   без всяких кнопок" и "сделай на веб размером с телефон". До этого дня страницу
   не проверял ни один набор: на ней оставалась кнопка "Держи и говори", а без
   доступа к микрофону подпись "Говорю…" залипала и ход не кончался никогда.

   Сценарии:
     WRM-0x  настоящая речь через поддельный микрофон Chromium и БОЕВОЕ распознавание:
             ни одного клика - шкала двигается, банан заряжается сам, рогатка стреляет,
             на следующем ходу игра снова слушает сама
     WRM-1x  микрофон запрещён: игра говорит словами, тап по фразе заряжает
     WRM-2x  тишина: на сервер не уходит ни одного запроса, после двух кругов - тап
     WRM-3x  сказал не то: одна бесплатная попытка, потом кривой заряд
     WRM-4x  кнопка "послушать": пока игра говорит, микрофон молчит, потом слушает сам
     WRM-5x  телефонный формат на окнах 390x844, 766x600, 1280x800
     WRM-6x  полный бой до победы: банан улетает, стрелок цел, бот отвечает, ход возвращается
     WRM-7x  полный бой до поражения: свой банан, упавший обратно, ранит

   Запуск: node qa/run-worms.mjs [--base=https://english-kombat.vercel.app] [--shots=папка]
   ⚠️ Сценарий WRM-0x ходит в боевой /api/island/transcribe (один-два запроса).
   ============================================================================= */
import { loadPlaywright, pickExecutable, startServer, scenario, check, report, API_HOST } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const BASE = arg('base'), SHOTS = arg('shots'), PAGE = arg('page') || 'island/worms.html';
const AUDIO = path.join(__dirname, 'audio', 'p1_pause.wav');     // "One board please" + 2.5 с тишины
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let ORIGIN = BASE, browser = null;

function initDenied() {
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
}
function initSilentMic() {   // микрофон есть, но в нём тишина
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext(); const dst = ac.createMediaStreamDestination();
    const g = ac.createGain(); g.gain.value = 0; const o = ac.createOscillator(); o.connect(g); g.connect(dst); o.start();
    return dst.stream;
  };
}
function initTts() {
  window.__tts = [];
  const stub = { speak(u) { window.__tts.push(u.text); setTimeout(() => { try { u.onend && u.onend({}); } catch (e) {} }, 300); },
    cancel() {}, pause() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => stub });
}

async function open({ viewport = { width: 390, height: 844 }, mic = 'file', transcript = null } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (mic !== 'denied') await ctx.grantPermissions(['microphone'], { origin: ORIGIN }).catch(() => {});
  await ctx.addInitScript(initTts);
  if (mic === 'denied') await ctx.addInitScript(initDenied);
  if (mic === 'silent') await ctx.addInitScript(initSilentMic);
  const calls = { transcribe: 0 };
  await ctx.route(`${API_HOST}/**`, async route => {
    const u = route.request().url();
    if (u.includes('/api/island/content')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: { battle: [{ ru: 'Одну доску, пожалуйста', en: 'One board, please', ans: ['one board please', 'one board'] }] } }) });
    if (u.includes('/api/island/transcribe')) {
      calls.transcribe++;
      if (transcript === null) return route.continue();              // боевое распознавание
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transcript, confidence: 0.9 }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const page = await ctx.newPage();
  page.errors = []; page.calls = calls; page.ctx = ctx;
  page.on('pageerror', e => page.errors.push(String(e && e.message || e)));
  await page.goto(`${ORIGIN}/${PAGE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mBot', { timeout: 15000 });
  await page.waitForTimeout(700);                                    // фразы с сервера (подменены) успевают прийти
  return page;
}
// Часы стенда. Headless рисует арену программным WebGL: под нагрузкой это 3 кадра в секунду, а Phaser
// считает игровое время кадрами (не больше 16.7 мс на кадр), поэтому 650 мс до конца броска шли 13 секунд
// и стенд видел "бот молчит". Здесь цикл отрисовки усыплён, игру шагает таймер без отрисовки:
// игровое время идёт вровень с настоящим на любой машине. Код игры при этом тот же самый.
const turbo = page => page.evaluate(() => {
  if (window.__clock) return;
  game.loop.sleep(); let last = performance.now();
  window.__clock = setInterval(() => { const now = performance.now(); let n = Math.min(30, Math.floor((now - last) / 16.667));
    last += n * 16.667; while (n-- > 0) game.headlessStep(now, 16.667); }, 8);
});
const startBot = async page => { await page.click('#mBot');
  await page.waitForFunction(() => typeof SCENE !== 'undefined' && SCENE && SCENE.turn === 'me', null, { timeout: 90000 });
  await turbo(page); };
const info = page => page.evaluate(() => ({
  turn: SCENE.turn, charged: SCENE.charged, miss: !!SCENE.missKick, busy: SCENE.busy,
  heard: document.getElementById('spHeard').textContent, card: document.getElementById('speech').style.display !== 'none',
  hint: SCENE.ui.hint.visible ? SCENE.ui.hint.text : '', phrase: document.getElementById('spEn').textContent,
  buttons: [...document.querySelectorAll('#speech button')].filter(b => b.offsetHeight > 0).map(b => b.textContent.trim()),
  hasHold: !!document.getElementById('spMic') || /Держи|Зажми/i.test(document.getElementById('speech').innerText),
  tap: !!document.getElementById('spPhrase') && document.getElementById('spPhrase').classList.contains('tap')
}));
const waitHeard = (page, rx, timeout = 15000) => page.waitForFunction(r => new RegExp(r).test(document.getElementById('spHeard').textContent), rx.source, { timeout }).then(() => true).catch(() => false);
const shot = async (page, name) => { if (SHOTS) await page.evaluate(() => game.step(performance.now(), 16.667)).catch(() => {}); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
// рогатка: тянем назад-вниз от бойца, отпускаем
async function sling(page) {
  const p = await page.evaluate(() => { const c = document.querySelector('#game canvas').getBoundingClientRect(); const k = c.width / CFG.W;
    return { x: c.left + SCENE.myWorm.x * k, y: c.top + SCENE.myWorm.y * k, k }; });
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x - 170 * p.k, p.y + 120 * p.k, { steps: 6 }); await page.mouse.up();
}

/* ── полный бой ── */
// журнал бросков: кто бросил, как далеко улетел банан, что стало со здоровьем обоих
const watchShots = page => page.evaluate(() => {
  window.__shots = []; const sc = SCENE, fire = sc.fire.bind(sc);
  sc.fire = (from, vx, vy, mine) => { __shots.push({ mine: !!mine, x0: from.x, y0: from.y, far: 0, frames: 0, me0: sc.myWorm.hp, foe0: sc.foeWorm.hp, me1: null, foe1: null });
    return fire(from, vx, vy, mine); };
  const end = sc.endShot.bind(sc);
  sc.endShot = () => { const s = __shots[__shots.length - 1]; if (s && s.me1 === null) { s.me1 = sc.myWorm.hp; s.foe1 = sc.foeWorm.hp; } return end(); };
  setInterval(() => { const s = __shots[__shots.length - 1]; if (s && sc.banana) { s.frames++; s.far = Math.max(s.far, Math.round(Math.hypot(sc.banana.obj.x - s.x0, sc.banana.obj.y - s.y0))); } }, 4);
});
// прицел: перебираем силу и угол формулой самой игры, берём бросок, который ложится ближе всех к цели
function pickAim(mode) {
  const sc = SCENE, me = sc.myWorm, foe = sc.foeWorm;
  if (mode === 'self') return { vx: 0, vy: -8 };                       // вверх и обратно на себя
  let best = null;
  for (let sp = 6; sp <= 23; sp += 0.5) for (let a = 25; a <= 75; a += 2.5) {
    const dir = Math.sign(foe.x - me.x) || 1; let vx = Math.cos(a * Math.PI / 180) * sp * dir, vy = -Math.sin(a * Math.PI / 180) * sp;
    let x = me.x, y = me.y - 20, wx = vx, wy = vy, miss = 1e9;
    for (let i = 0; i < 600; i++) { wy += G; wx += sc.wind * 0.012; x += wx; y += wy;
      if (Math.hypot(x - foe.x, y - foe.y + 16) < 34) { miss = 0; break; }
      if (sc.solid(x, y) || y > sc.WATER_Y + 12 || x < -60 || x > sc.W + 60) { miss = Math.hypot(x - foe.x, y - foe.y + 16); break; } }
    if (!best || miss < best.miss) best = { vx, vy, miss };
  }
  return best;
}
async function slingAim(page, mode) {
  const v = await page.evaluate(pickAim, mode);
  const p = await page.evaluate(() => { const c = document.querySelector('#game canvas').getBoundingClientRect(); const k = c.width / CFG.W;
    return { x: c.left + c.width * 0.6, y: c.top + c.height * 0.35, k }; });
  // рогатка: скорость = вектор натяжения / 10 (сила = длина / 230, потолок 23). Тянем от середины поля, а не
  // от бойца: он стоит в 74 px от левого края, сильный бросок уводил палец за край окна, и отпускание терялось
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x - v.vx * 10 * p.k, p.y - v.vy * 10 * p.k, { steps: 5 }); await page.mouse.up();
  return v;
}
// бой до конца: mode 'foe' - целимся в соперника, 'self' - бросаем вверх на себя
async function fight(page, mode, maxTurns = 14) {
  await watchShots(page); let turns = 0, stuck = '';
  for (; turns < maxTurns; turns++) {
    const st = await page.waitForFunction(() => SCENE.turn === 'over' ? 'over' : (SCENE.turn === 'me' && !SCENE.busy && document.getElementById('spPhrase').classList.contains('tap') ? 'me' : false), null, { timeout: 30000 })
      .then(h => h.jsonValue()).catch(() => 'stuck');
    if (st === 'over') break;
    if (st === 'stuck') { stuck = 'ход не вернулся: ' + JSON.stringify(await info(page)); break; }
    await page.click('#spPhrase');
    if (!await page.waitForFunction(() => SCENE.charged, null, { timeout: 6000 }).then(() => true).catch(() => false)) { stuck = 'тап не зарядил'; break; }
    const n0 = await page.evaluate(() => __shots.length);
    await slingAim(page, mode);
    if (!await page.waitForFunction(n => __shots.length > n, n0, { timeout: 6000 }).then(() => true).catch(() => false)) { stuck = 'рогатка не выстрелила'; break; }
  }
  const end = await page.evaluate(() => ({ turn: SCENE.turn, shots: __shots, me: SCENE.myWorm.hp, foe: SCENE.foeWorm.hp,
    texts: SCENE.children.list.filter(o => o.type === 'Text').map(o => o.text),
    trophies: (JSON.parse(localStorage.getItem('ek_island_v1') || '{}').league || {}).trophies || 0 }));
  return { ...end, turns, stuck };
}
function measureCard() {
  const app = document.getElementById('app').getBoundingClientRect();
  const card = document.getElementById('speech').getBoundingClientRect();
  const ids = ['spRu', 'spEn', 'spEq', 'spHeard', 'spSay'];
  const b = ids.map(id => ({ id, r: document.getElementById(id).getBoundingClientRect() })).filter(x => x.r.height > 0);
  const over = []; let pairs = 0;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) { pairs++;
    const v = Math.min(b[i].r.bottom, b[j].r.bottom) - Math.max(b[i].r.top, b[j].r.top), h = Math.min(b[i].r.right, b[j].r.right) - Math.max(b[i].r.left, b[j].r.left);
    if (v > 1 && h > 1) over.push(b[i].id + '×' + b[j].id); }
  const out = b.filter(x => x.r.left < card.left - 1 || x.r.right > card.right + 1 || x.r.bottom > card.bottom + 1).map(x => x.id);
  const back = document.querySelector('.back-link').getBoundingClientRect();
  const cv = document.querySelector('#game canvas').getBoundingClientRect();
  return { appW: Math.round(app.width), appH: Math.round(app.height), ratio: +(app.height / app.width).toFixed(2), pairs, over, out,
    cardIn: card.left >= app.left - 1 && card.right <= app.right + 1 && card.bottom <= app.bottom + 1,
    backIn: back.left >= app.left && back.right <= app.right && back.left >= 0,
    wormsClear: [SCENE.myWorm, SCENE.foeWorm].every(wm => cv.top + (wm.y + 30) * (cv.height / CFG.H) <= card.top + 2),
    canvasIn: cv.left >= app.left - 1 && cv.right <= app.right + 1, canvasW: Math.round(cv.width), fieldPortrait: CFG.H > CFG.W, win: [innerWidth, innerHeight] };
}

(async () => {
  let srv = null;
  if (!BASE) { const s = await startServer(); srv = s.srv; ORIGIN = `http://127.0.0.1:${s.port}`; }
  console.log(`Worms-арена: ${ORIGIN}/${PAGE}`);
  const pw = loadPlaywright();
  browser = await pw.chromium.launch({ headless: true, executablePath: pickExecutable(false) || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + AUDIO,
           '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
           // стенд детерминирован: headless иногда считает страницу фоновой и душит таймеры до 1 раза в секунду
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  try {
    { scenario('Настоящая речь, боевое распознавание, ни одного клика по записи');
      const page = await open({});
      await startBot(page);
      const a = await info(page);
      check('WRM-01', 'На своём ходу нет кнопки записи "Держи и говори"', !a.hasHold, JSON.stringify(a.buttons));
      check('WRM-02', 'Игра сама слушает и говорит об этом словами', a.card && /Слушаю/.test(a.heard), a.heard);
      let maxH = 0; for (let i = 0; i < 40 && maxH <= 8; i++) { maxH = Math.max(maxH, ...(await page.evaluate(() => [...document.querySelectorAll('#spEq i')].map(b => parseFloat(b.style.height) || 0)))); await page.waitForTimeout(100); }
      check('WRM-03', `Шкала голоса двигается от речи (максимум ${maxH.toFixed(1)}px, покой 4px)`, maxH > 8);
      await shot(page, 'worms-390-listening');
      const ok = await waitHeard(page, /заряжено/, 25000);
      const heard = (await info(page)).heard;
      await page.waitForFunction(() => SCENE.charged, null, { timeout: 4000 }).catch(() => {});
      const b = await info(page);
      check('WRM-04', `Фраза распознана и банан заряжен без единого касания: ${heard}`, ok && b.charged && !b.miss, JSON.stringify(b));
      check('WRM-05', 'После заряда карточка убрана и показана подсказка про рогатку', !b.card && /рогатк/.test(b.hint), JSON.stringify({ card: b.card, hint: b.hint }));
      await sling(page);
      const fired = await page.waitForFunction(() => SCENE.busy || SCENE.turn !== 'me', null, { timeout: 4000 }).then(() => true).catch(() => false);
      check('WRM-06', 'Рогатка стреляет заряженным бананом', fired);
      const again = await page.waitForFunction(() => SCENE.turn === 'me' && !SCENE.busy && /Слушаю/.test(document.getElementById('spHeard').textContent), null, { timeout: 40000 }).then(() => true).catch(() => false);
      const c = await page.evaluate(() => SCENE.turn);
      check('WRM-07', 'На следующем своём ходу игра снова слушает сама', again || c === 'over', `ход: ${c}`);
      check('WRM-08', 'Нет ошибок скрипта', page.errors.length === 0, page.errors.join(' | '));
      await page.ctx.close(); }

    { scenario('Микрофон запрещён средой');
      const page = await open({ mic: 'denied', viewport: { width: 766, height: 600 } });
      await startBot(page);
      const told = await waitHeard(page, /тапни по фразе/, 8000);
      const a = await info(page);
      check('WRM-10', 'Игра словами говорит, что микрофона нет, и зовёт тапнуть по фразе', told && /икрофон/.test(a.heard), a.heard);
      check('WRM-11', 'Подпись "Говорю…" не залипает', !/Говорю/.test(a.heard), a.heard);
      await shot(page, 'worms-766-denied');
      await page.click('#spPhrase');
      await page.waitForFunction(() => SCENE.charged, null, { timeout: 4000 }).catch(() => {});
      const b = await info(page);
      check('WRM-12', 'Тап по фразе заряжает банан', b.charged && !b.miss, JSON.stringify(b));
      await sling(page);
      check('WRM-13', 'И банан летит', await page.waitForFunction(() => SCENE.busy || SCENE.turn !== 'me', null, { timeout: 4000 }).then(() => true).catch(() => false));
      await page.ctx.close(); }

    { scenario('Микрофон есть, но игрок молчит');
      const page = await open({ mic: 'silent', transcript: 'should not be called' });
      await startBot(page);
      const told = await waitHeard(page, /Не слышу/, 12000);
      const tap = await page.waitForFunction(() => document.getElementById('spPhrase').classList.contains('tap'), null, { timeout: 12000 }).then(() => true).catch(() => false);
      const a = await info(page);
      check('WRM-20', 'На тишину игра отвечает "не слышу тебя" и продолжает слушать', told && a.card && !a.charged, a.heard);
      check('WRM-21', `Тишина не уходит на сервер: запросов распознавания ${page.calls.transcribe}`, page.calls.transcribe === 0);
      check('WRM-22', 'После двух кругов тишины можно тапнуть по фразе', tap, a.heard);
      await page.click('#spPhrase'); await page.waitForFunction(() => SCENE.charged, null, { timeout: 4000 }).catch(() => {});
      check('WRM-23', 'Тап заряжает', (await info(page)).charged);
      await page.ctx.close(); }

    { scenario('Сказал не то');
      const page = await open({ transcript: 'banana potato' });
      await startBot(page);
      const retry = await waitHeard(page, /ещё раз/, 20000);
      check('WRM-30', 'Первая неверная фраза - бесплатная попытка "ещё раз"', retry && !(await info(page)).charged, (await info(page)).heard);
      const crooked = await page.waitForFunction(() => SCENE.charged && SCENE.missKick, null, { timeout: 25000 }).then(() => true).catch(() => false);
      const b = await info(page);
      check('WRM-31', 'Вторая неверная - кривой заряд, ход не встаёт', crooked && /Крив/.test(b.hint), b.heard + ' | детектор: ' + JSON.stringify(await page.evaluate(() => window.__vadLog)));
      check('WRM-32', 'Игра вслух произносит верную фразу', (await page.evaluate(() => window.__tts)).includes('One board, please'));
      await page.ctx.close(); }

    { scenario('Кнопка "послушать"');
      const page = await open({ mic: 'silent', transcript: '' });
      await startBot(page);
      await waitHeard(page, /Слушаю/, 5000);
      // подпись читаем в том же тике, что и клик: подменённый синтез заканчивает фразу за 300 мс
      const a = await page.evaluate(() => { document.getElementById('spSay').click(); return { heard: document.getElementById('spHeard').textContent }; });
      const back = await waitHeard(page, /Слушаю/, 6000);
      check('WRM-40', 'Пока игра произносит фразу, она не слушает; потом слушает сама', /Слушай/.test(a.heard) && back, `во время: "${a.heard}"`);
      check('WRM-41', 'Фраза произнесена', (await page.evaluate(() => window.__tts)).includes('One board, please'));
      await page.ctx.close(); }


    { scenario('Полный бой: целюсь в соперника, до победы');
      const page = await open({ mic: 'denied' });
      await startBot(page);
      const r = await fight(page, 'foe');
      const mine = r.shots.filter(s => s.mine), bot = r.shots.filter(s => !s.mine);
      const m0 = mine[0] || {};
      check('WRM-60', `Мой банан улетает от бойца: ${m0.far} px (раньше 0: взрывался на стрелке в первом кадре)`, m0.far > 100, JSON.stringify(m0));
      check('WRM-61', `Прицельный бросок не ранит самого стрелка: бросков ${mine.length}, со своим уроном ${mine.filter(s => s.me1 !== null && s.me1 < s.me0).length}`, mine.length > 0 && mine.every(s => s.me1 === null || s.me1 >= s.me0), JSON.stringify(mine.map(s => [s.me0, s.me1])));
      check('WRM-62', `Прицельный бросок ранит соперника: попаданий ${mine.filter(s => s.foe1 !== null && s.foe1 < s.foe0).length} из ${mine.length}`, mine.some(s => s.foe1 !== null && s.foe1 < s.foe0), JSON.stringify(mine.map(s => [s.foe0, s.foe1, s.far])));
      check('WRM-63', `Бот отвечает броском: бросков бота ${bot.length}, дальность первого ${(bot[0] || {}).far} px`, r.turn === 'over' && mine.length === 1 ? true : (bot.length > 0 && bot[0].far > 100), JSON.stringify(bot.map(s => s.far)));
      check('WRM-64', `После броска бота ход возвращается игроку: моих бросков ${mine.length}`, !r.stuck && (mine.length > 1 || r.turn === 'over'), r.stuck);
      check('WRM-65', `Бой дошёл до экрана победы за ${mine.length} моих бросков (я ${r.me}, он ${r.foe})`, r.turn === 'over' && r.texts.some(t => /ПОБЕДА/.test(t)) && r.foe <= 0, JSON.stringify({ turn: r.turn, stuck: r.stuck, me: r.me, foe: r.foe }));
      check('WRM-66', `За победу начислены кубки: ${r.trophies}`, r.trophies === 10);
      check('WRM-67', 'Нет ошибок скрипта за весь бой', page.errors.length === 0, page.errors.join(' | '));
      await shot(page, 'worms-win');
      await page.ctx.close(); }

    { scenario('Полный бой: бросаю вверх на себя, до поражения');
      const page = await open({ mic: 'denied' });
      await startBot(page);
      const r = await fight(page, 'self');
      const mine = r.shots.filter(s => s.mine);
      check('WRM-70', `Свой банан, упавший обратно, ранит стрелка: таких бросков ${mine.filter(s => s.me1 !== null && s.me1 < s.me0).length} из ${mine.length}`, mine.some(s => s.me1 !== null && s.me1 < s.me0 && s.far >= 44), JSON.stringify(mine.map(s => [s.me0, s.me1, s.far])));
      check('WRM-71', `Бой дошёл до экрана поражения (я ${r.me}, он ${r.foe})`, r.turn === 'over' && r.texts.some(t => /ПОРАЖЕНИЕ/.test(t)) && r.me <= 0, JSON.stringify({ turn: r.turn, stuck: r.stuck }));
      check('WRM-72', 'На экране конца есть "Ещё раз", кубки за поражение не начислены', r.texts.some(t => /Ещё раз/.test(t)) && r.trophies === 0, String(r.trophies));
      check('WRM-73', 'Нет ошибок скрипта за весь бой', page.errors.length === 0, page.errors.join(' | '));
      await page.ctx.close(); }

    for (const [w, h] of [[390, 844], [766, 600], [1280, 800]]) {
      scenario(`Телефонный формат, окно ${w}x${h}`);
      const page = await open({ mic: 'denied', viewport: { width: w, height: h } });
      await startBot(page);
      await waitHeard(page, /тапни/, 8000);
      await page.waitForTimeout(400);
      const m = await page.evaluate(measureCard);
      check(`WRM-5${w}-1`, `Игра в колонке шириной с телефон: ${m.appW}x${m.appH} при окне ${w}x${h}`, m.appW <= 520 && m.appW <= w && m.ratio >= 1.5, JSON.stringify(m));
      check(`WRM-5${w}-2`, 'Поле портретное, канвас, карточка фразы и кнопка "назад" внутри колонки', m.fieldPortrait && m.canvasIn && m.cardIn && m.backIn, JSON.stringify(m));
      check(`WRM-5${w}-3`, `Строки карточки не наезжают и не вылезают: пар ${m.pairs}, наложений ${m.over.length}, за краем ${m.out.length}`, !m.over.length && !m.out.length, m.over.concat(m.out).join(','));
      check(`WRM-5${w}-4`, 'Карточка фразы не закрывает бойцов', m.wormsClear, JSON.stringify({ win: m.win, app: [m.appW, m.appH] }));
      await shot(page, `worms-${w}x${h}`);
      await page.ctx.close();
    }
  } catch (e) { check('WRM-00', 'Прогон дошёл до конца', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' / ')); }
  await browser.close(); if (srv) srv.close();
  process.exit(report(BASE ? 'last-run-worms-live.json' : 'last-run-worms.json') ? 1 : 0);
})();
