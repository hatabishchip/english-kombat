#!/usr/bin/env node
/* =============================================================================
   БОЙ ОСТРОВА НА РАЗНОЙ ШИРИНЕ ПОЛЯ (набор BAN).

   Появился 27.11.2026: скорости банана были подобраны под телефонное поле 390,
   а на компьютере поле шире (до 520) - банан не долетал вовсе. Без микрофона
   (запасной путь "тапни по фразе", сила 60) бой было нельзя выиграть, а чисто
   сказанная фраза (сила 75) промахивалась 17 раз из 21. Стенд этого не видел,
   потому что все наборы гоняли одно окно 390x844.

   Проверяет на трёх окнах: без микрофона игра говорит об этом словами, тап по
   фразе бросает банан, и первый же бросок снимает сопернику здоровье.

   Запуск:
     node qa/run-banana.mjs
     node qa/run-banana.mjs --base=https://english-kombat.vercel.app
   API Острова подменён оснасткой (qa/harness.mjs), в боевую базу ничего не пишется.
   ============================================================================= */
import { loadPlaywright, pickExecutable, startServer, scenario, check, report, newPage, walkFunnel } from './harness.mjs';

const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=').slice(1).join('=');

(async () => {
  let srv = null, origin = BASE;
  if (!BASE) { const s = await startServer(); srv = s.srv; origin = `http://127.0.0.1:${s.port}`; }
  console.log(`Бой Острова: ${origin}/island`);
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true, executablePath: pickExecutable(false) || undefined });

  for (const [w, h] of [[390, 844], [766, 600], [1280, 800]]) {
    scenario(`Бой без микрофона, окно ${w}x${h}`);
    const page = await newPage(browser, { viewport: { width: w, height: h } });
    try {
      await page.goto(`${origin}/island`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#s-perm.on', { timeout: 10000 });
      await page.click('#permSkip');
      await walkFunnel(page, { name: 'Банан' });
      await page.click('#bigStart');
      await page.waitForSelector('#s-map.on', { timeout: 15000 });
      await page.click('#tabbar .tab[data-go="fight"]');
      await page.waitForSelector('#s-fight.on', { timeout: 8000 });
      const waitTap = () => page.waitForFunction(() => /тапни по фразе/.test(document.getElementById('fightHeard').textContent), null, { timeout: 12000 })
        .then(() => true).catch(() => false);
      const told = await waitTap();
      const field = await page.evaluate(() => Math.round(document.getElementById('fightCanvas').getBoundingClientRect().width));
      check(`BAN-${w}-01`, `Без микрофона бой словами зовёт тапнуть по фразе (ширина поля ${field})`, told,
        await page.evaluate(() => document.getElementById('fightHeard').textContent));

      const hp = () => page.evaluate(() => ({ foe: +document.getElementById('foeHp').textContent, me: +document.getElementById('meHp').textContent }));
      const start = await hp();
      const drops = [];
      for (let turn = 0; turn < 3; turn++) {
        if (!(await waitTap())) break;
        const before = (await hp()).foe;
        await page.click('#fightCta .fight-phrase');
        // банан летит, потом ход соперника; подпись "тапни" пропадает с новой фразой - это и есть конец хода
        await page.waitForFunction(() => !/тапни/.test(document.getElementById('fightHeard').textContent), null, { timeout: 9000 }).catch(() => {});
        drops.push(before - (await hp()).foe);
        if ((await hp()).foe <= 0) break;
      }
      const end = await hp();
      check(`BAN-${w}-02`, `Каждый бросок по тапу снимает сопернику здоровье: бросков ${drops.length}, урон ${JSON.stringify(drops)}`,
        drops.length > 0 && drops.every(d => d > 0), `здоровье соперника ${start.foe} -> ${end.foe}`);
      check(`BAN-${w}-03`, 'Нет ошибок скрипта', page.captured.pageErrors.length === 0, page.captured.pageErrors.slice(0, 3).join(' | '));
    } catch (e) {
      check(`BAN-${w}-00`, 'Сценарий дошёл до конца', false, String(e && e.message || e).split('\n')[0]);
    }
    await page.ctx.close();
  }
  await browser.close();
  if (srv) srv.close();
  process.exit(report(BASE ? 'last-run-banana-live.json' : 'last-run-banana.json') ? 1 : 0);
})();
