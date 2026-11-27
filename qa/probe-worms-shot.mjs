import { loadPlaywright, pickExecutable, startServer, API_HOST } from '/Users/oleksandrdiachuk/english-kombat/qa/harness.mjs';
const pw = loadPlaywright(); const { srv, port } = await startServer();
const browser = await pw.chromium.launch({ headless: true, executablePath: pickExecutable(false) || undefined, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const PAGE = process.argv[2] || 'island/worms.html';
for (let run = 0; run < 3; run++) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })); });
  await ctx.route(`${API_HOST}/**`, r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${port}/${PAGE}`); await page.waitForTimeout(600);
  await page.click('#mBot'); await page.waitForFunction(() => SCENE && SCENE.turn === 'me');
  const log = [];
  for (let turn = 0; turn < 3; turn++) {
    const ok = await page.waitForFunction(() => SCENE.turn === 'over' || (SCENE.turn === 'me' && !SCENE.busy), null, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!ok) { log.push('ЗАВИС: ' + JSON.stringify(await page.evaluate(() => ({ turn: SCENE.turn, busy: SCENE.busy, banana: !!SCENE.banana, me: [SCENE.myWorm.hp, SCENE.myWorm.alive], foe: [SCENE.foeWorm.hp, SCENE.foeWorm.alive] })))); break; }
    if (await page.evaluate(() => SCENE.turn === 'over')) { log.push('конец боя'); break; }
    const before = await page.evaluate(() => ({ me: SCENE.myWorm.hp, foe: SCENE.foeWorm.hp }));
    // заряд напрямую и выстрел рогаткой
    await page.evaluate(() => { SCENE.charged = true; SCENE.missKick = false; document.getElementById('speech').style.display = 'none'; });
    const p = await page.evaluate(() => { const c = document.querySelector('#game canvas').getBoundingClientRect(); const k = c.width / CFG.W; return { x: c.left + SCENE.myWorm.x * k, y: c.top + SCENE.myWorm.y * k, k }; });
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x - 170 * p.k, p.y + 120 * p.k, { steps: 6 }); await page.mouse.up();
    // путь банана: сколько кадров прожил и как далеко улетел
    const fl = await page.evaluate(() => new Promise(res => { const x0 = SCENE.myWorm.x; let far = 0, n = 0; const t0 = performance.now();
      const iv = setInterval(() => { if (SCENE.banana) { n++; far = Math.max(far, Math.abs(SCENE.banana.obj.x - x0)); } if (SCENE.turn !== 'me' || performance.now() - t0 > 8000) { clearInterval(iv); res({ far: Math.round(far), samples: n, ms: Math.round(performance.now() - t0), dist: Math.round(Math.abs(SCENE.foeWorm.x - x0)) }); } }, 16); }));
    const mid = await page.evaluate(() => ({ me: SCENE.myWorm.hp, foe: SCENE.foeWorm.hp }));
    log.push(`мой выстрел: улетел на ${fl.far} из ${fl.dist} до соперника за ${fl.ms} мс; я ${before.me}->${mid.me}, он ${before.foe}->${mid.foe}`);
  }
  console.log(`бой ${run + 1}: ` + log.join(' | '));
  await ctx.close();
}
await browser.close(); srv.close();
