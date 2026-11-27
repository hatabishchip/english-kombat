#!/usr/bin/env node
/* =============================================================================
   WORMS-АРЕНА, ЖИВОЙ БОЙ ДВУХ ИГРОКОВ (набор PVP).

   Появился 27.11.2026: живой бой арены не открывал ни один набор, а владелец и
   партнёр собираются смотреть бету вдвоём. Два окна браузера заходят в "Живой бой
   1на1", попадают в одну комнату БОЕВОГО сервера комнат и играют до конца.

   Запуск: node qa/run-worms-pvp.mjs [--base=https://english-kombat.vercel.app]
   ⚠️ Ходит в боевой сервер комнат (wss://ek-pvp...): создаёт одну комнату worms_duel
      на минуту-две. В общий прогон не входит, запускать отдельно.
   ⚠️ Если в эту секунду живой игрок ищет соперника, одно из окон попадёт к нему:
      тогда PVP-01 падает и стенд выходит из боя, ничего не бросая.
   ============================================================================= */
import { loadPlaywright, pickExecutable, startServer, scenario, check, report, API_HOST } from './harness.mjs';
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=').slice(1).join('=');
const NAMES = ['Стенд-А', 'Стенд-Б'];

function init(name) {
  try { localStorage.setItem('ek_island_v1', JSON.stringify({ name })); } catch (e) {}
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  const stub = { speak(u) { setTimeout(() => { try { u.onend && u.onend({}); } catch (e) {} }, 200); }, cancel() {}, pause() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => stub });
}
// часы стенда: без отрисовки, вровень с настоящим временем (урок L-37)
const turbo = page => page.evaluate(() => {
  if (window.__clock) return;
  game.loop.sleep(); let last = performance.now();
  window.__clock = setInterval(() => { const now = performance.now(); let n = Math.min(30, Math.floor((now - last) / 16.667));
    last += n * 16.667; while (n-- > 0) game.headlessStep(now, 16.667); }, 8);
  window.__shots = []; const sc = SCENE, fire = sc.fire.bind(sc);
  sc.fire = (from, vx, vy, mine) => { __shots.push({ mine: !!mine, x0: from.x, y0: from.y, far: 0, me0: sc.myWorm.hp, foe0: sc.foeWorm.hp }); return fire(from, vx, vy, mine); };
  setInterval(() => { const s = __shots[__shots.length - 1]; if (s && sc.banana) s.far = Math.max(s.far, Math.round(Math.hypot(sc.banana.obj.x - s.x0, sc.banana.obj.y - s.y0))); }, 4);
});
function pickAim() {
  const sc = SCENE, me = sc.myWorm, foe = sc.foeWorm; let best = null;
  for (let sp = 6; sp <= 23; sp += 0.5) for (let a = 25; a <= 75; a += 2.5) {
    const dir = Math.sign(foe.x - me.x) || 1; const vx = Math.cos(a * Math.PI / 180) * sp * dir, vy = -Math.sin(a * Math.PI / 180) * sp;
    let x = me.x, y = me.y - 20, wx = vx, wy = vy, miss = 1e9;
    for (let i = 0; i < 600; i++) { wy += G; wx += sc.wind * 0.012; x += wx; y += wy;
      if (Math.hypot(x - foe.x, y - foe.y + 16) < 34) { miss = 0; break; }
      if (sc.solid(x, y) || y > sc.WATER_Y + 12 || x < -60 || x > sc.W + 60) { miss = Math.hypot(x - foe.x, y - foe.y + 16); break; } }
    if (!best || miss < best.miss) best = { vx, vy, miss };
  }
  return best;
}
async function slingAim(page) {
  const v = await page.evaluate(pickAim);
  const p = await page.evaluate(() => { const c = document.querySelector('#game canvas').getBoundingClientRect(); return { x: c.left + c.width * 0.5, y: c.top + c.height * 0.35, k: c.width / CFG.W }; });
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x - v.vx * 10 * p.k, p.y - v.vy * 10 * p.k, { steps: 5 }); await page.mouse.up();
}
const st = page => page.evaluate(() => ({ turn: SCENE.turn, busy: SCENE.busy, me: SCENE.myWorm.hp, foe: SCENE.foeWorm.hp, meAlive: SCENE.myWorm.alive, foeAlive: SCENE.foeWorm.alive,
  shots: window.__shots || [], texts: SCENE.children.list.filter(o => o.type === 'Text').map(o => o.text), ui: SCENE.ui.turn.text }));

(async () => {
  let srv = null, origin = BASE;
  if (!BASE) { const s = await startServer(); srv = s.srv; origin = `http://127.0.0.1:${s.port}`; }
  console.log(`Живой бой арены: ${origin}/island/worms.html, сервер комнат ${API_HOST}`);
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true, executablePath: pickExecutable(false) || undefined,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const pages = [];
  try {
    scenario('Два игрока в одной комнате, бой до конца');
    for (const name of NAMES) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await ctx.addInitScript(init, name);
      await ctx.route(`${API_HOST}/api/island/**`, route => route.fulfill({ status: 200, contentType: 'application/json',
        body: route.request().url().includes('/content') ? JSON.stringify({ data: { battle: [{ ru: 'Одну доску, пожалуйста', en: 'One board, please', ans: ['one board please'] }] } }) : '{"ok":true}' }));
      const page = await ctx.newPage(); page.errors = []; page.ctx = ctx; page.who = name;
      page.on('pageerror', e => page.errors.push(String(e && e.message || e)));
      await page.goto(`${origin}/island/worms.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#mLive', { timeout: 15000 }); await page.waitForTimeout(700);
      pages.push(page);
    }
    await pages[0].click('#mLive'); await pages[0].waitForTimeout(800); await pages[1].click('#mLive');
    const joined = await Promise.all(pages.map(p => p.waitForFunction(() => typeof SCENE !== 'undefined' && SCENE && SCENE.turn && SCENE.ui, null, { timeout: 60000 }).then(() => true).catch(() => false)));
    const cfg = joined.every(Boolean) ? await Promise.all(pages.map(p => p.evaluate(() => ({ mode: CFG.mode, seed: CFG.seed, names: CFG.names, W: CFG.W, H: CFG.H,
      surf: [100, 300, 450, 600, 800].map(x => SCENE.surfaceY(x)), me: [Math.round(SCENE.myWorm.x), SCENE.mySeat], turn: SCENE.turn })))) : [];
    const together = cfg.length === 2 && cfg.every(c => c.mode === 'pvp') && NAMES.every(n => Object.values(cfg[0].names || {}).includes(n));
    check('PVP-01', `Оба окна попали в одну комнату: ${cfg[0] ? JSON.stringify(cfg[0].names) : 'бой не начался'}`, together, JSON.stringify(joined));
    if (together) {
      await Promise.all(pages.map(turbo));
      check('PVP-02', `Рельеф у обоих одинаков: зерно ${cfg[0].seed}, высоты ${cfg[0].surf.join(',')}`, cfg[0].seed === cfg[1].seed && cfg[0].surf.join() === cfg[1].surf.join(), cfg[1].surf.join(','));
      check('PVP-03', `Ход ровно у одного: ${cfg.map(c => c.turn).join(' / ')}, места ${cfg.map(c => c.me[1]).join(' / ')}`, cfg.filter(c => c.turn === 'me').length === 1 && cfg[0].me[1] !== cfg[1].me[1]);
      let turns = 0, seen = 0, hpMismatch = 0, selfHit = 0, passed = 0, stuck = '', covered = 0; const log = [];
      for (; turns < 16; turns++) {
        // чей ход
        let a = -1;
        for (let i = 0; i < 300 && a < 0; i++) { const s = await Promise.all(pages.map(st)); if (s.some(x => x.turn === 'over')) { a = -2; break; }
          a = s.findIndex(x => x.turn === 'me' && !x.busy); if (a < 0) await pages[0].waitForTimeout(100); }
        if (a === -2) break;
        if (a < 0) { stuck = 'ход ни у кого: ' + JSON.stringify((await Promise.all(pages.map(st))).map(x => [x.turn, x.busy, x.ui])); break; }
        const A = pages[a], B = pages[1 - a];
        if (!await A.waitForFunction(() => document.getElementById('spPhrase').classList.contains('tap'), null, { timeout: 10000 }).then(() => true).catch(() => false)) { stuck = 'нет приглашения тапнуть'; break; }
        const clear = await A.evaluate(() => { const cv = document.querySelector('#game canvas').getBoundingClientRect(), card = document.getElementById('speech').getBoundingClientRect();
          return [SCENE.myWorm, SCENE.foeWorm].every(wm => cv.top + (wm.y + 30) * (cv.height / CFG.H) <= card.top + 2); });
        if (!clear) covered++;
        await A.click('#spPhrase');
        if (!await A.waitForFunction(() => SCENE.charged, null, { timeout: 6000 }).then(() => true).catch(() => false)) { stuck = 'тап не зарядил'; break; }
        const nB = (await st(B)).shots.length, before = await st(A);
        await slingAim(A);
        const sawShot = await B.waitForFunction(n => (window.__shots || []).length > n, nB, { timeout: 8000 }).then(() => true).catch(() => false);
        if (sawShot) seen++;
        // ход ушёл от бросавшего (или бой кончился)
        const moved = await A.waitForFunction(() => SCENE.turn !== 'me', null, { timeout: 20000 }).then(() => true).catch(() => false);
        if (moved) passed++; else { stuck = 'ход не ушёл от бросавшего: ' + JSON.stringify(await st(A)); break; }
        await A.waitForTimeout(900);
        const sa = await st(A), sb = await st(B);
        if (sa.me !== sb.foe || sa.foe !== sb.me) hpMismatch++;
        if (sa.me < before.me && sa.foe === before.foe) selfHit++;
        const far = (sa.shots.filter(x => x.mine).pop() || {}).far, farB = (sb.shots.filter(x => !x.mine).pop() || {}).far;
        log.push(`${A.who}: банан ${far}px (у соперника виден: ${sawShot ? farB + 'px' : 'нет'}), здоровье ${before.me}/${before.foe} -> ${sa.me}/${sa.foe}, у соперника ${sb.foe}/${sb.me}`);
        if (sa.turn === 'over' || sb.turn === 'over') { turns++; break; }
      }
      const end = await Promise.all(pages.map(st));
      console.log(log.map(l => '    ' + l).join('\n'));
      check('PVP-04', `Бросок одного виден у другого: ${seen} из ${log.length}`, log.length > 0 && seen === log.length);
      check('PVP-05', `Здоровье после броска совпадает у обоих окон: расхождений ${hpMismatch} из ${log.length}`, log.length > 0 && hpMismatch === 0);
      check('PVP-06', `Ход переходит к сопернику: ${passed} из ${log.length}`, log.length > 1 && passed === log.length, stuck);
      check('PVP-07', `Прицельный бросок не ранит самого стрелка: случаев ${selfHit} из ${log.length}`, selfHit === 0);
      const win = end.filter(e => e.texts.some(t => /ПОБЕДА/.test(t))).length, lose = end.filter(e => e.texts.some(t => /ПОРАЖЕНИЕ/.test(t))).length;
      check('PVP-08', `Бой дошёл до конца за ${log.length} бросков: у одного "ПОБЕДА", у другого "ПОРАЖЕНИЕ" (${win}/${lose})`, !stuck && win === 1 && lose === 1, stuck || JSON.stringify(end.map(e => [e.turn, e.me, e.foe])));
      check('PVP-09', `Карточка фразы не закрывает бойцов на своём ходу: закрывала ${covered} из ${log.length}`, covered === 0);
      check('PVP-10', 'Нет ошибок скрипта у обоих', pages.every(p => p.errors.length === 0), pages.map(p => p.errors.join(' | ')).join(' || '));
    }
  } catch (e) { check('PVP-00', 'Прогон дошёл до конца', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' / ')); }
  for (const p of pages) await p.ctx.close().catch(() => {});
  await browser.close(); if (srv) srv.close();
  process.exit(report(BASE ? 'last-run-worms-pvp-live.json' : 'last-run-worms-pvp.json') ? 1 : 0);
})();
