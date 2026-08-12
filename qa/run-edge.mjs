#!/usr/bin/env node
/* =============================================================================
   ЗЛОЙ СТЕНД ОСТРОВА - то, чего не покрывает qa/run-funnel.mjs.

   Наборы (префиксы проверок):
     STATE - повторный вход, перезагрузка посреди воронки, старые сохранения,
             задвоение аналитики при втором проходе
     EVIL  - быстрые и злые действия игрока: дабл-тапы, длинные имена,
             эмодзи, HTML-инъекции, короткие реплики текстом
     MTX   - ВСЕ 16 комбинаций ответов на вопросы №1-4 против правила маршрута
     BAD   - злой контент из админки: нет вопросов, один вопрос, correct вне
             диапазона, удалённые варианты анкеты, пустой кружок, битое видео

   Запуск:
     node qa/run-edge.mjs                 # всё
     node qa/run-edge.mjs --only=BAD      # только один набор
     node qa/run-edge.mjs --headed        # с окном
   ============================================================================= */
import {
  loadPlaywright, pickExecutable, startServer, scenario, check, report,
  newPage, chipTexts, lastIn, allText, state, waitChip, clickChip, waitBubble,
  passCircle, openIsland, walkFunnel
} from './harness.mjs';

const ARGS = process.argv.slice(2);
const ONLY = (ARGS.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const HEADED = ARGS.includes('--headed');
let PORT = 0;
const want = p => !ONLY || p.startsWith(ONLY) || ONLY === 'ALL';

// верные индексы дефолтного теста (content-defaults.js)
const CORRECT = [1, 1, 0, 1, 1, 1];
const pickFor = flags => CORRECT.map((c, i) => (flags[i] ? c : (c + 1) % 3));

/* ═══ STATE · повторный вход и состояние ═══════════════════════════════════ */
async function runState(browser) {
  scenario('Повторный вход, перезагрузка, старые сохранения');

  // 1. Перезагрузка на шаге цели
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await passCircle(page);
    await waitBubble(page, /Как тебя зовут/i);
    await page.fill('#onbInput', 'Петя');
    await page.press('#onbInput', 'Enter');
    await waitBubble(page, /Для чего ты хочешь/i);
    const before = await state(page);
    check('STATE-01', 'До перезагрузки имя лежит в сохранении', before.name === 'Петя', `S.name=${before.name}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#s-perm.on', { timeout: 3000 }).catch(() => {});
    await page.click('#permSkip').catch(() => {});
    const backToOnb = await page.waitForSelector('#s-onb.on', { timeout: 8000 }).then(() => true).catch(() => false);
    check('STATE-02', 'После перезагрузки игрок снова в онбординге', backToOnb);
    // ожидаемое поведение: продолжаем с сохранённого шага (цель), кружок и имя заново не показываем
    const resumed = await waitBubble(page, /Для чего ты хочешь/i, 12000).then(() => true).catch(() => false);
    check('STATE-03', 'После перезагрузки воронка продолжает с того же шага, имя не переспрашивают',
      resumed, await allText(page).catch(() => ''));
    const after = await state(page);
    check('STATE-03b', 'Имя пережило перезагрузку', after.name === 'Петя', `S.name=${after.name}`);
    await page.ctx.close();
  }

  // 2. Перезагрузка на 3-м вопросе теста
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await passCircle(page);
    await waitBubble(page, /Как тебя зовут/i);
    await page.fill('#onbInput', 'Катя'); await page.press('#onbInput', 'Enter');
    await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
    await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
    await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 12000 });
    await passCircle(page);
    await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
    await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 3, null, { timeout: 12000 });
    await passCircle(page);
    for (let i = 0; i < 2; i++) {
      await waitBubble(page, new RegExp('Вопрос ' + (i + 1) + ' из'));
      await (await page.$$('#onbQuick .chip'))[0].click();
    }
    await waitBubble(page, /Вопрос 3 из/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#s-perm.on', { timeout: 3000 }).catch(() => {});
    await page.click('#permSkip').catch(() => {});
    await page.waitForSelector('#s-onb.on', { timeout: 8000 }).catch(() => {});
    await waitBubble(page, /Вопрос 3 из/, 12000).catch(() => {});
    const txt = await allText(page).catch(() => '');
    check('STATE-04', 'Перезагрузка на 3-м вопросе не роняет игру', !/undefined|NaN/.test(txt), txt.slice(0, 120));
    check('STATE-05', 'Прогресс теста после перезагрузки не потерян полностью',
      /Вопрос 3 из/.test(txt), 'тест начинается заново с кружка знакомства, ответы 1-2 стёрты');
    await page.ctx.close();
  }

  // 3. Старое сохранение прошлой версии (probes: level/track от старой системы)
  {
    const legacy = JSON.stringify({
      name: 'Старичок', level: 'A2', track: 'probe-hard', xp: 120, ammo: 4, coins: 30,
      locIdx: 0, locDone: 0, streak: 3, learned: ['one board please'], probes: [1, 0, 1]
    });
    const page = await newPage(browser, { storage: legacy });
    await openIsland(page, PORT);
    const onb = await page.waitForSelector('#s-onb.on', { timeout: 8000 }).then(() => true).catch(() => false);
    check('STATE-06', 'Старое сохранение не роняет загрузку', onb, 'онбординг не открылся');
    await walkFunnel(page, { name: 'Старичок', picks: pickFor([0, 0, 0, 0, 0, 0]) });
    const st = await state(page);
    check('STATE-07', 'Мусорный level из старой версии перезаписан новым',
      ['beginner', 'mid', 'advanced'].includes(st.level), `S.level=${st.level}`);
    check('STATE-08', 'Мусорный track из старой версии перезаписан новым',
      ['basic', 'advanced'].includes(st.track), `S.track=${st.track}`);
    check('STATE-09', 'Старое сохранение не даёт ошибок в консоли',
      page.captured.consoleErrors.length === 0, page.captured.consoleErrors.slice(0, 3).join(' | '));
    await page.ctx.close();
  }

  // 4. Второй проход воронки: задваивается ли аналитика
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await walkFunnel(page, { name: 'Дубль', picks: pickFor([1, 1, 1, 1, 1, 1]) });
    await page.click('#bigStart');
    await page.waitForSelector('#s-map.on', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    const afterFirst = page.captured.quizResults.length;
    check('STATE-10', 'Первый проход отправил ровно одну запись аналитики', afterFirst === 1, `отправок: ${afterFirst}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#s-perm.on', { timeout: 3000 }).catch(() => {});
    await page.click('#permSkip').catch(() => {});
    const onMapAgain = await page.waitForSelector('#s-map.on', { timeout: 6000 }).then(() => true).catch(() => false);
    check('STATE-11', 'Игрок, прошедший онбординг, после перезагрузки попадает на карту, а не в воронку заново',
      onMapAgain, 'после перезагрузки снова показан онбординг: условие возврата требует locDone>0');

    if (!onMapAgain) {
      await walkFunnel(page, { name: 'Дубль', picks: pickFor([1, 1, 1, 1, 1, 1]) });
      await page.waitForTimeout(400);
      check('STATE-12', 'Повторный проход не задваивает аналитику',
        page.captured.quizResults.length === 1, `отправок стало: ${page.captured.quizResults.length}`);
    }
    await page.ctx.close();
  }
}

/* ═══ EVIL · быстрые и злые действия ═══════════════════════════════════════ */
async function runEvil(browser) {
  scenario('Быстрые и злые действия игрока');

  // 1. Дабл/трипл-тап по варианту ответа
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await passCircle(page);
    await waitBubble(page, /Как тебя зовут/i);
    await page.fill('#onbInput', 'Быстрый'); await page.press('#onbInput', 'Enter');
    await waitChip(page, /./);
    const chips = await page.$$('#onbQuick .chip');
    await chips[0].click({ clickCount: 3, delay: 20 }).catch(() => {});
    const askedTime = await waitBubble(page, /Сколько времени/i, 8000).then(() => true).catch(() => false);
    await page.waitForTimeout(600);
    const outs = await page.$$eval('#chatScroll .row.out .bubble', els => els.map(e => e.innerText.trim()));
    check('EVIL-01', 'Тройной тап по варианту цели пишет ровно один ответ',
      outs.filter(t => /Путешеств|Работа|Учёба|Общение|себя/i.test(t)).length === 1, `реплики игрока: ${outs.join(' | ')}`);
    check('EVIL-02', 'Тройной тап не проскакивает следующий вопрос', askedTime, await lastIn(page));
    await page.ctx.close();
  }

  // 2. Многократный тап по кружку
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await page.waitForSelector('#chatScroll .vcircle', { timeout: 12000 });
    const vc = (await page.$$('#chatScroll .vcircle'))[0];
    for (let i = 0; i < 5; i++) { await vc.click(); await page.waitForTimeout(70); }
    await page.waitForTimeout(2000);
    const names = (await allText(page)).match(/Как тебя зовут/g) || [];
    check('EVIL-03', 'Пять тапов по кружку не задваивают вопрос об имени',
      names.length <= 1, `вопрос про имя показан ${names.length} раз(а)`);
    check('EVIL-04', 'Многократный тап по кружку не роняет страницу',
      page.captured.pageErrors.length === 0, page.captured.pageErrors.slice(0, 2).join(' | '));
    await page.ctx.close();
  }

  // 3. Злое имя: 300 символов
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await passCircle(page);
    await waitBubble(page, /Как тебя зовут/i);
    await page.fill('#onbInput', 'Я'.repeat(300));
    await page.press('#onbInput', 'Enter');
    await waitBubble(page, /Для чего ты хочешь/i);
    const st = await state(page);
    check('EVIL-05', 'Имя в 300 символов обрезано до разумной длины',
      (st.name || '').length <= 24, `длина имени: ${(st.name || '').length}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('EVIL-06', 'Длинное имя не ломает вёрстку по ширине', overflow <= 1, `перелив ${overflow}px`);
    await page.ctx.close();
  }

  // 4. Имя из эмодзи
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await passCircle(page);
    await waitBubble(page, /Как тебя зовут/i);
    await page.fill('#onbInput', '🥷🔥🏝️');
    await page.press('#onbInput', 'Enter');
    const moved = await waitBubble(page, /Для чего ты хочешь/i, 8000).then(() => true).catch(() => false);
    check('EVIL-07', 'Имя из эмодзи принимается', moved, await lastIn(page));
    const st = await state(page);
    check('EVIL-08', 'Эмодзи-имя сохранено без порчи', (st.name || '').includes('🥷'), `S.name=${st.name}`);
    await page.ctx.close();
  }

  // 5. Имя с HTML-инъекцией: доходим до итога, где имя подставляется в шаблон
  {
    const page = await newPage(browser);
    await page.addInitScript(() => { window.__xss = 0; window.__xssHook = () => { window.__xss++; }; });
    await openIsland(page, PORT);
    const evil = '<img src=x onerror=window.__xssHook()>';
    await passCircle(page);
    await waitBubble(page, /Как тебя зовут/i);
    await page.fill('#onbInput', evil);
    await page.press('#onbInput', 'Enter');
    await waitBubble(page, /Для чего ты хочешь/i);
    const imgInChat = await page.$$eval('#chatScroll img', els => els.length);
    check('EVIL-09', 'HTML в имени не превращается в разметку в чате', imgInChat === 0, `картинок в чате: ${imgInChat}`);
    await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
    await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
    await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 12000 });
    await passCircle(page);
    await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
    await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 3, null, { timeout: 12000 });
    await passCircle(page);
    for (let i = 0; i < 6; i++) {
      await waitBubble(page, new RegExp('Вопрос ' + (i + 1) + ' из'));
      await (await page.$$('#onbQuick .chip'))[0].click();
    }
    await page.waitForSelector('#bigStart', { timeout: 12000 });
    const xss = await page.evaluate(() => window.__xss || 0);
    check('EVIL-10', 'Инъекция в имени не исполняется в итоговом сообщении', xss === 0, `сработало обработчиков: ${xss}`);
    const imgs = await page.$$eval('#chatScroll img', els => els.length);
    check('EVIL-11', 'В итоговом сообщении нет вставленной картинки', imgs === 0, `картинок: ${imgs}`);
    await page.ctx.close();
  }

  // 6. Короткая реплика текстом на шаге теста
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await walkFunnelToQuiz(page, 'Короткий');
    await waitBubble(page, /Вопрос 1 из/);
    await page.fill('#onbInput', 'да');
    await page.press('#onbInput', 'Enter');
    await page.waitForTimeout(1800);
    const text = await allText(page);
    const jumped = /Вопрос 2 из/.test(text);
    check('EVIL-12', 'Короткая реплика «да» на вопросе теста НЕ засчитывается как выбор ответа',
      !jumped, 'matchOption сопоставляет по подстроке: «да» попало в «Узнать, где продаётся вода» и стало ответом');
    await page.ctx.close();
  }
}

async function walkFunnelToQuiz(page, name) {
  await passCircle(page);
  await waitBubble(page, /Как тебя зовут/i);
  await page.fill('#onbInput', name); await page.press('#onbInput', 'Enter');
  await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
  await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 2, null, { timeout: 12000 });
  await passCircle(page);
  await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
  await page.waitForFunction(() => document.querySelectorAll('#chatScroll .vcircle').length >= 3, null, { timeout: 12000 });
  await passCircle(page);
}

/* ═══ MTX · все 16 комбинаций ответов на вопросы №1-4 ══════════════════════ */
/* ═══ RST · выход из профиля и старт заново (фидбек Романа 10.08) ═══════════ */
async function runReset(browser) {
  scenario('Кнопка «начать сначала»');

  const page = await newPage(browser);
  await openIsland(page, PORT);
  await walkFunnel(page, { name: 'Сбросыч', picks: pickFor([1, 1, 1, 1, 1, 1]) });
  await page.click('#bigStart');
  await page.waitForSelector('#s-map.on', { timeout: 12000 });

  const hasBtn = await page.$('#resetBtn').then(e => !!e);
  check('RST-01', 'На карте есть кнопка «начать сначала»', hasBtn,
    'человеку неоткуда выйти из профиля - именно на это пожаловался Роман');

  if (hasBtn) {
    await page.click('#resetBtn');
    await page.waitForSelector('#overlay.on', { timeout: 5000 }).catch(() => {});
    const txt = await page.evaluate(() => document.querySelector('#sheet')?.innerText || '');
    check('RST-02', 'Сброс просит подтверждения, а не стирает молча',
      /сначала|сотр/i.test(txt), txt.slice(0, 80));
    const hasCancel = await page.$('#sheetCancel').then(e => !!e);
    check('RST-03', 'У подтверждения есть отмена', hasCancel,
      'окно без отмены - ловушка на необратимом действии');

    // отмена не должна ничего стирать
    if (hasCancel) {
      await page.click('#sheetCancel');
      await page.waitForTimeout(400);
      const kept = await state(page);
      check('RST-04', 'Отмена сохраняет прогресс', kept && kept.name === 'Сбросыч',
        `S.name=${kept && kept.name}`);
    }

    // а подтверждение - стирает и возвращает в начало
    await page.click('#resetBtn');
    await page.waitForSelector('#sheetCta', { timeout: 5000 });
    await page.click('#sheetCta');
    await page.waitForSelector('#s-perm.on, #s-onb.on', { timeout: 12000 }).catch(() => {});
    await page.click('#permSkip').catch(() => {});
    const backToOnb = await page.waitForSelector('#s-onb.on', { timeout: 10000 })
      .then(() => true).catch(() => false);
    check('RST-05', 'После подтверждения знакомство идёт с начала', backToOnb);
    const after = await state(page);
    check('RST-06', 'Прогресс и имя стёрты', !after || !after.name, `S.name=${after && after.name}`);
  }
  await page.ctx.close();

  // Найдено на iPhone: верхняя панель не переносилась, и кнопка сброса уезжала
  // за правый край - человек её не видел вовсе.
  {
    const page = await newPage(browser, { width: 390, height: 844 });
    await openIsland(page, PORT);
    await walkFunnel(page, { name: 'Узкий', picks: pickFor([1, 1, 1, 1, 1, 1]) });
    await page.click('#bigStart');
    await page.waitForSelector('#s-map.on', { timeout: 12000 });
    const fit = await page.evaluate(() => {
      const b = document.querySelector('#resetBtn');
      if (!b) return { ok: false, why: 'кнопки нет' };
      const r = b.getBoundingClientRect();
      return { ok: r.right <= window.innerWidth + 1 && r.left >= -1 && r.width > 0,
               why: `right=${Math.round(r.right)} при ширине ${window.innerWidth}` };
    });
    check('RST-07', 'Кнопка «начать сначала» помещается на узком экране', fit.ok, fit.why);

    // Найдено на iPhone: карточка с боевой фразой выросла и накрыла бойцов.
    // Верхняя половина экрана обязана оставаться свободной под них.
    await page.click('#tabbar .tab:nth-child(3)').catch(() => {});
    const okFight = await page.waitForSelector('#s-fight.on', { timeout: 8000 }).then(() => true).catch(() => false);
    if (okFight) {
      await page.waitForTimeout(600);
      const room = await page.evaluate(() => {
        const cta = document.querySelector('.fight-cta');
        const cv = document.querySelector('#fightCanvas');
        if (!cta || !cv) return { ok: false, why: 'экран боя не отрисован' };
        const c = cta.getBoundingClientRect(), v = cv.getBoundingClientRect();
        return { ok: c.top >= v.top + v.height * 0.5,
                 why: `верх карточки ${Math.round(c.top - v.top)} при высоте поля ${Math.round(v.height)}` };
      });
      check('FGT-01', 'Карточка боя не залезает в верхнюю половину - бойцам есть место', room.ok, room.why);

      // бой без кнопок: ни «Послушать», ни «Держи и говори», ни «Бросить»
      const ui = await page.evaluate(() => ({
        say: !!document.querySelector('#fightSay'),
        mic: !!document.querySelector('#fightMic'),
        fire: !!document.querySelector('#fireBtn'),
        power: !!document.querySelector('#powerWrap'),
        eq: document.querySelectorAll('#fightEq i').length,
        foeStrip: !!document.querySelector('#foeTurn'),
      }));
      check('FGT-02', 'Кнопки «Послушать», «Держи и говори» и «Бросить» убраны',
        !ui.say && !ui.mic && !ui.fire && !ui.power, JSON.stringify(ui));
      check('FGT-03', 'Есть живая шкала голоса и полоска хода соперника',
        ui.eq > 10 && ui.foeStrip, `столбиков ${ui.eq}`);

      // Человек молчит (в стенде микрофон пустой): ход обязан пойти дальше сам,
      // а не зависнуть навсегда. Ждём переход хода к сопернику или запасной путь.
      const moved = await page.waitForFunction(() => {
        const st = (document.querySelector('#fightHeard')||{}).textContent || '';
        const foe = document.querySelector('#fightCta')?.classList.contains('foe');
        return foe || /тапни|микрофон|выпал|повтори/i.test(st);
      }, null, { timeout: 20000 }).then(() => true).catch(() => false);
      const st = await page.evaluate(() => ({
        s: (document.querySelector('#fightHeard')||{}).textContent || '',
        foe: !!document.querySelector('#fightCta')?.classList.contains('foe') }));
      check('FGT-04', 'Молчание не вешает бой: ход идёт дальше сам',
        moved, `статус "${st.s}", ход соперника: ${st.foe}`);
    }
  }
  await page.ctx.close();
}

async function beaconSteps(page){
  const b = await page.evaluate(() => (window.__beacons || []).map(x => x.body));
  return b.map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
}
/* ═══ TLM · телеметрия воронки: видно ли, где человек ушёл ═════════════════ */
async function runTelemetry(browser) {
  scenario('Телеметрия знакомства');

  // 1. Полный проход: отметки идут по порядку и без повторов
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await walkFunnel(page, { name: 'Метрикыч', picks: pickFor([1, 1, 1, 1, 1, 1]) });
    await page.click('#bigStart');
    await page.waitForSelector('#s-map.on', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(600);
    const ev = await beaconSteps(page);
    const steps = ev.map(x => x.step);
    check('TLM-01', 'Отмечен вход в игру', steps.includes('open'), steps.join(','));
    check('TLM-02', 'Отмечены шаги анкеты', ['name','goal','time','exp'].every(x => steps.includes(x)), steps.join(','));
    check('TLM-03', 'Отмечены вопросы теста по номерам',
      ['quiz1','quiz3','quiz6'].every(x => steps.includes(x)), steps.join(','));
    check('TLM-04', 'Отмечен показ маршрута и выход на карту',
      steps.includes('route') && steps.includes('map'), steps.join(','));
    check('TLM-05', 'Один человек - одна отметка на шаг',
      new Set(steps).size === steps.length, steps.join(','));
    const sids = new Set(ev.map(x => x.sid));
    check('TLM-06', 'Все отметки одного человека с одним ключом', sids.size === 1, [...sids].join(','));
    await page.ctx.close();
  }

  // 2. Ушёл на середине: видно, ГДЕ именно, и дальше отметок нет
  {
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await passCircle(page);
    await waitBubble(page, /Как тебя зовут/i);
    await page.fill('#onbInput', 'Ушёл');
    await page.press('#onbInput', 'Enter');
    await waitBubble(page, /Для чего ты хочешь/i);
    await page.waitForTimeout(400);
    const steps = (await beaconSteps(page)).map(x => x.step);
    check('TLM-07', 'Дошедшие шаги отмечены', steps.includes('name') && steps.includes('goal'), steps.join(','));
    check('TLM-08', 'Шаги, до которых не дошёл, НЕ отмечены',
      !steps.includes('quiz1') && !steps.includes('route') && !steps.includes('map'), steps.join(','));
    await page.ctx.close();
  }

  // 3. Телеметрия не мешает игроку: сервер отметок лежит - воронка всё равно проходится
  {
    const page = await newPage(browser, { blockStep: true });
    await openIsland(page, PORT);
    await walkFunnel(page, { name: 'Безсети', picks: pickFor([0, 0, 0, 0, 0, 0]) });
    const gotStart = await page.$('#bigStart').then(e => !!e);
    check('TLM-09', 'Упавшая телеметрия не ломает знакомство', gotStart,
      'воронка не дошла до конца при недоступном сервере отметок');
    check('TLM-10', 'Упавшая телеметрия не роняет игру исключением',
      page.captured.pageErrors.length === 0, page.captured.pageErrors.slice(0, 2).join(' | '));
    await page.ctx.close();
  }
}

async function runMatrix(browser) {
  scenario('Матрица маршрута: все 16 комбинаций вопросов №1-4');
  let n = 0;
  for (let mask = 0; mask < 16; mask++) {
    const f = [ (mask >> 3) & 1, (mask >> 2) & 1, (mask >> 1) & 1, mask & 1, 0, 0 ];
    const adv = !!(f[2] && f[3]);
    const expTrack = adv ? 'advanced' : 'basic';
    const expLevel = adv ? 'advanced' : ((f[0] && f[1]) ? 'mid' : 'beginner');
    const id = String(++n).padStart(2, '0');
    const page = await newPage(browser);
    await openIsland(page, PORT);
    await walkFunnel(page, { name: 'Матрица', picks: pickFor(f) });
    const st = await state(page);
    const shown = await lastIn(page);
    await page.waitForTimeout(300);
    const sent = page.captured.quizResults[0] || {};
    const tag = `q1${f[0] ? '+' : '-'} q2${f[1] ? '+' : '-'} q3${f[2] ? '+' : '-'} q4${f[3] ? '+' : '-'}`;
    check(`MTX-${id}a`, `${tag}: трек ${expTrack}`, st.track === expTrack, `S.track=${st.track}`);
    check(`MTX-${id}b`, `${tag}: уровень ${expLevel}`, st.level === expLevel, `S.level=${st.level}`);
    check(`MTX-${id}c`, `${tag}: в тексте игроку назван тот же маршрут`,
      new RegExp(expTrack, 'i').test(shown), `показано: "${shown}"`);
    check(`MTX-${id}d`, `${tag}: на сервер ушли те же трек и уровень`,
      sent.track === expTrack && sent.level === expLevel, `отправлено track=${sent.track} level=${sent.level}`);
    await page.ctx.close();
  }
}

/* ═══ BAD · злой контент из админки ════════════════════════════════════════ */
async function runBadContent(browser) {
  scenario('Злой контент из админки');

  // 1. Роман удалил все вопросы теста
  {
    const page = await newPage(browser, { content: { quiz: { questions: [], hint: 'Тест пуст' } } });
    await openIsland(page, PORT);
    await walkFunnelToQuiz(page, 'Пусто');
    const alive = await page.waitForFunction(
      () => !!document.querySelector('#bigStart') || /Вопрос 1 из/.test(document.querySelector('#chatScroll').innerText),
      null, { timeout: 15000 }).then(() => true).catch(() => false);
    check('BAD-01', 'Пустой список вопросов не вешает воронку (дефолты или сразу маршрут)', alive,
      'ни вопросов, ни кнопки START за 15с');
    await page.ctx.close();
  }

  // 2. Один вопрос
  {
    const one = { quiz: { questions: [{ en: 'Hi there', ask: 'Что это?', options: ['Приветствие', 'Прощание'], correct: 0 }] } };
    const page = await newPage(browser, { content: one });
    await openIsland(page, PORT);
    await walkFunnelToQuiz(page, 'Один');
    const q1 = await waitBubble(page, /Вопрос 1 из 1/, 12000).then(() => true).catch(() => false);
    check('BAD-02', 'Один вопрос показан как «Вопрос 1 из 1»', q1, await lastIn(page));
    await waitChip(page, /./); await (await page.$$('#onbQuick .chip'))[0].click();
    const done = await page.waitForSelector('#bigStart', { timeout: 12000 }).then(() => true).catch(() => false);
    check('BAD-03', 'Тест из одного вопроса доводит до START', done);
    const st = await state(page);
    check('BAD-04', 'При одном вопросе маршрут = basic/beginner', st.track === 'basic' && st.level === 'beginner',
      `track=${st.track} level=${st.level}`);
    await page.ctx.close();
  }

  // 3. correct вне диапазона
  {
    const bad = {
      quiz: {
        questions: [0, 1, 2, 3, 4, 5].map(i => ({
          en: 'Phrase ' + i, ask: 'Вопрос ' + i, options: ['A' + i, 'B' + i, 'C' + i], correct: 5
        }))
      }
    };
    const page = await newPage(browser, { content: bad });
    await openIsland(page, PORT);
    await walkFunnel(page, { name: 'Кривой', picks: [0, 1, 2, 0, 1, 2] });
    const st = await state(page);
    check('BAD-05', 'correct=5 при трёх вариантах не роняет игру, маршрут basic',
      st.track === 'basic' && st.level === 'beginner', `track=${st.track} level=${st.level}`);
    check('BAD-06', 'При кривом correct нет исключений на странице',
      page.captured.pageErrors.length === 0, page.captured.pageErrors.slice(0, 2).join(' | '));
    await page.ctx.close();
  }

  // 4. Роман удалил все варианты цели
  {
    const page = await newPage(browser, { content: { survey: { goal: { ask: 'Для чего тебе английский?', options: [] } } } });
    await openIsland(page, PORT);
    await passCircle(page);
    await waitBubble(page, /Как тебя зовут/i);
    await page.fill('#onbInput', 'Тупик'); await page.press('#onbInput', 'Enter');
    // не должно быть тупика: либо есть кнопки, либо шаг проскакивается дальше
    const moved = await page.waitForFunction(
      () => /Сколько времени/i.test(document.querySelector('#chatScroll').innerText)
        || (!document.querySelector('#onbQuick').classList.contains('hidden')
            && document.querySelectorAll('#onbQuick .chip').length > 0),
      null, { timeout: 12000 }).then(() => true).catch(() => false);
    check('BAD-07', 'Шаг цели без вариантов не превращается в тупик', moved,
      'ни кнопок, ни перехода дальше: воронка встала намертво на шаге цели');
    const chips = await chipTexts(page);
    check('BAD-08', 'Пустой шаг цели не оставляет пустую панель кнопок висеть',
      chips.length > 0 || /Сколько времени/i.test(await allText(page)), `кнопки: ${chips.join(' | ')}`);
    await page.ctx.close();
  }

  // 5. Вопрос теста без вариантов ответа
  {
    const noOpts = { quiz: { questions: [{ en: 'Hello', ask: 'Что это?', options: [], correct: 0 }] } };
    const page = await newPage(browser, { content: noOpts });
    await openIsland(page, PORT);
    await walkFunnelToQuiz(page, 'Безвариантов');
    const alive = await page.waitForFunction(
      () => !!document.querySelector('#bigStart')
        || document.querySelectorAll('#onbQuick .chip').length > 0,
      null, { timeout: 14000 }).then(() => true).catch(() => false);
    check('BAD-09', 'Вопрос без вариантов ответа не вешает тест', alive,
      'вариантов нет и кнопка START не пришла - дальше пройти нечем');
    await page.ctx.close();
  }

  // 6. Пустой текст кружка
  {
    const page = await newPage(browser, { content: { circles: { c1: { who: 'Роман', text: '', video: '' } } } });
    await openIsland(page, PORT);
    await passCircle(page);
    const moved = await waitBubble(page, /Как тебя зовут/i, 20000).then(() => true).catch(() => false);
    check('BAD-10', 'Пустой текст кружка не вешает воронку', moved, 'после пустого кружка шаг имени не пришёл за 20с');
    await page.ctx.close();
  }

  // 7. Битый URL видео в кружке
  {
    const page = await newPage(browser, { content: { circles: { c1: { who: 'Роман', text: 'нет', video: 'https://example.invalid/nope.mp4' } } } });
    await openIsland(page, PORT);
    await page.waitForSelector('#chatScroll .vcircle', { timeout: 12000 });
    await passCircle(page);
    const moved = await waitBubble(page, /Как тебя зовут/i, 20000).then(() => true).catch(() => false);
    check('BAD-11', 'Битое видео кружка не вешает воронку', moved, 'видео не грузится и шаг имени не наступает');
    await page.ctx.close();
  }

  // 8. Кавычка в URL видео - не должна ломать разметку кружка
  {
    const evil = { circles: { c1: { who: 'Роман', text: 'x', video: 'a.mp4" onerror="window.__vidXss=1' } } };
    const page = await newPage(browser, { content: evil });
    await openIsland(page, PORT);
    await page.waitForSelector('#chatScroll .vcircle', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const hit = await page.evaluate(() => window.__vidXss || 0);
    check('BAD-12', 'Кавычка в URL видео не вырывается из атрибута', hit === 0,
      'esc() не экранирует кавычку, атрибут src разрывается и подставляется чужой обработчик');
    await page.ctx.close();
  }
}

/* ═══ запуск ═══════════════════════════════════════════════════════════════ */
(async () => {
  const { chromium } = loadPlaywright();
  const { srv, port } = await startServer();
  PORT = port;
  const exe = pickExecutable(HEADED);
  const browser = await chromium.launch({ headless: !HEADED, ...(exe ? { executablePath: exe } : {}) });
  console.log(`\x1b[1mЗлой стенд Острова\x1b[0m  сервер :${port}  ${HEADED ? 'с окном' : 'headless'}`);
  try {
    if (want('STATE')) await runState(browser);
    if (want('EVIL')) await runEvil(browser);
    if (want('MTX')) await runMatrix(browser);
    if (want('BAD')) await runBadContent(browser);
    if (want('RST')) await runReset(browser);
    if (want('TLM')) await runTelemetry(browser);
  } catch (e) {
    check('RUN-00', 'Стенд отработал без падений', false, String(e && e.stack || e));
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(report('last-run-edge.json') ? 1 : 0);
})();
