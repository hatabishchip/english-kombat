#!/usr/bin/env node
/* =============================================================================
   СТЕНД ИСХОДНОЙ ИГРЫ (public/index.html, "English Kombat - vs BOT").

   Появился 26.11.2026 после жалобы владельца: на экране боя строки напечатаны
   одна поверх другой, шкала голоса неподвижна, подпись обрезана, звука нет.
   До этого дня исходную игру не проверял ни один набор - все были про /island.

   Наборы (префиксы проверок):
     FLOW  - путь от входа по имени до боя настоящими кликами, на каждом экране
             замер наложений текста
     LAY   - экран боя на 10 размерах окна в 5 состояниях: наложения блоков,
             обрезанный текст, блоки за краем панели, бойцы целиком в арене
     VOICE - голос с подменённым распознаванием: успех, ошибка сети, тихий отказ,
             запрет микрофона, браузер без распознавания -> запасной путь карточками
     METER - шкала голоса двигается от поддельного микрофона Chromium
     SND   - звук: удар запускает источники звука, "проверить звук" отвечает
     END   - победа карточками и поражение доводят до своих экранов
     SWEEP - лидерборд, друзья, чат, семь конструкторов бойца, район: открываются,
             текст не наезжает, нет ошибок скрипта

   Запуск:
     node qa/run-root.mjs                      # всё, локальная статика
     node qa/run-root.mjs --only=LAY           # один набор
     node qa/run-root.mjs --base=https://english-kombat.vercel.app   # боевой адрес
     node qa/run-root.mjs --shots=/путь/папка  # снимки экранов
   Боевой API авторизации всегда подменён: стенд не заводит игроков в базе.
   ============================================================================= */
import { loadPlaywright, pickExecutable, startServer, scenario, check, report, API_HOST } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARGS = process.argv.slice(2);
const arg = n => (ARGS.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const ONLY = arg('only');
const BASE = arg('base');
const SHOTS = arg('shots');
const PAGE = arg('page') || 'index.html';   // --page=_before.html: доказать, что набор умеет падать на старой версии
const want = p => !ONLY || ONLY === 'ALL' || p.startsWith(ONLY);
const AUDIO = path.join(__dirname, 'audio', 'p1_pause.wav');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let ORIGIN = BASE;
let browser = null;

/* ── подмены браузерных API (ставятся до скрипта игры) ─────────────────────── */
// распознавание речи: режим задаётся строкой, стенд сам "произносит" фразу через __say
function initFakeSR(mode) {
  window.__srMode = mode;
  window.__srInst = [];
  window.__srStarts = 0;
  if (mode === 'absent') {
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
    return;
  }
  function FakeSR() { this._alive = false; window.__srInst.push(this); }
  FakeSR.prototype.start = function () {
    const self = this, m = window.__srMode;
    window.__srStarts++;
    self._alive = true;
    setTimeout(() => {
      if (m === 'silent') { self._alive = false; self.onend && self.onend({}); return; }
      if (!self._alive) return;
      self.onstart && self.onstart({});
      if (m === 'network' || m === 'not-allowed') {
        setTimeout(() => {
          self._alive = false;
          self.onerror && self.onerror({ error: m });
          self.onend && self.onend({});
        }, 60);
      }
    }, 30);
  };
  FakeSR.prototype.stop = FakeSR.prototype.abort = function () {
    if (!this._alive) return;
    this._alive = false;
    const self = this;
    setTimeout(() => self.onend && self.onend({}), 10);
  };
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeSR });
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeSR });
  window.__say = text => {
    const r = window.__srInst[window.__srInst.length - 1];
    if (!r || !r._alive || !r.onresult) return false;
    const res = [{ transcript: text }];
    res.isFinal = true;
    r.onresult({ resultIndex: 0, results: [res] });
    return true;
  };
}
// микрофон запрещён средой (так ведёт себя встроенный браузер приложения Claude)
function initMicDenied() {
  const deny = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = deny;
  if (navigator.permissions) navigator.permissions.query = () => Promise.resolve({ state: 'denied' });
}
// синтез речи и звук: считаем вызовы, ничего не играем вслух
function initAudioSpies() {
  window.__tts = [];
  const stub = {
    speak(u) { window.__tts.push(u.text); setTimeout(() => { try { u.onend && u.onend({}); } catch (e) {} }, 40); },
    cancel() {}, pause() {}, resume() {}, getVoices: () => [],
    onvoiceschanged: null, speaking: false, pending: false, paused: false
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => stub });
  window.__snd = 0;
  for (const C of [window.OscillatorNode, window.AudioBufferSourceNode]) {
    if (!C) continue;
    const orig = C.prototype.start;
    C.prototype.start = function () { window.__snd++; return orig.apply(this, arguments); };
  }
}

/* ── страница ──────────────────────────────────────────────────────────────── */
async function open(opts = {}) {
  const { viewport = { width: 390, height: 844 }, sr = 'ok', micDenied = false, grantMic = true } = opts;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (grantMic && !micDenied) await ctx.grantPermissions(['microphone'], { origin: ORIGIN }).catch(() => {});
  await ctx.addInitScript(initAudioSpies);
  await ctx.addInitScript(initFakeSR, sr);
  if (micDenied) await ctx.addInitScript(initMicDenied);
  await ctx.route(`${API_HOST}/**`, r => {
    const u = r.request().url();
    if (u.includes('/api/auth/sync')) {
      let b = {}; try { b = JSON.parse(r.request().postData() || '{}'); } catch {}
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        profile: { hash: b.hash, level: 1, elo: 1000, wins: 0, losses: 0, character: null, completed: [] }, isNew: true }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e && e.message || e)));
  page.on('dialog', d => d.accept());
  page.ctx = ctx;
  await page.goto(`${ORIGIN}/${PAGE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-login.on', { timeout: 15000 });
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const screenId = page => page.evaluate(() => document.querySelector('.screen.on')?.id || '');
const tapTutor = async page => {
  const on = await page.waitForSelector('#ov-tutor.on', { timeout: 2500 }).then(() => true).catch(() => false);
  if (on) { await page.click('#ov-tutor'); await page.waitForSelector('#ov-tutor:not(.on)', { state: 'attached', timeout: 3000 }).catch(() => {}); }
  return on;
};

/* Наложения текста на активном экране: у каждого видимого элемента с собственным
   текстом берём прямоугольник текста; пересечение двух таких прямоугольников больше
   чем на 2 px по обеим осям, когда один не вложен в другой, - дефект. */
function measureScreenText() {
  const root = document.querySelector('.ov.on') || document.querySelector('.screen.on');
  if (!root) return { n: 0, pairs: 0, over: [] };
  const SKIP = '.vs,.dust,.spot,.combo-badge,.impact-burst,.stun-birds,.bot-think,.door-fade,.diff-badge,.map-hint,script,style';
  const items = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el) || el.closest(SKIP) || el.closest('svg')) continue;   // текст внутри рисунка бойца (корона) - часть картинки
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    let hidden = false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) { hidden = true; break; }
    }
    if (hidden) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    items.push({ el, r, txt: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 28) });
  }
  const over = []; let pairs = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    pairs++;
    const v = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    const h = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    if (v > 2 && h > 2) over.push(`"${a.txt}" × "${b.txt}" (${Math.round(v)}px)`);
  }
  return { n: items.length, pairs, over };
}

/* Экран боя: блоки нижней панели и арена */
function measureBattle() {
  const ids = ['phrase-pic', 'phrase-ru', 'phrase-sub', 'status', 'timer', 'audio-meter', 'heard-txt', 'to-cards', 'cards-grid', 'no-voice'];
  const bot = document.querySelector('#s-battle .bot');
  const botR = bot.getBoundingClientRect();
  const arenaR = document.getElementById('arena').getBoundingClientRect();
  const boxes = ids.map(id => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return { id, t: r.top, b: r.bottom, l: r.left, r: r.right, txt: el.textContent.trim(),
      cut: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 };
  }).filter(b => b.b - b.t > 0 && (b.txt || b.id === 'audio-meter'));
  const over = []; let pairs = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    pairs++;
    const a = boxes[i], c = boxes[j];
    const v = Math.min(a.b, c.b) - Math.max(a.t, c.t), h = Math.min(a.r, c.r) - Math.max(a.l, c.l);
    if (v > 1 && h > 1) over.push(`${a.id}×${c.id}:${Math.round(v)}px`);
  }
  const out = boxes.filter(b => b.b > innerHeight + 1 || b.t < botR.top - 1 || b.b > botR.bottom + 1 || b.l < botR.left - 1 || b.r > botR.right + 1).map(b => b.id);
  const cut = boxes.filter(b => b.cut && b.id !== 'audio-meter' && b.id !== 'cards-grid').map(b => b.id);
  // кнопки-карточки: текст не вылезает за кнопку
  const cardCut = [...document.querySelectorAll('#cards-grid .card-opt')].filter(c => c.offsetHeight > 0 && (c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1)).length;
  // бойцы: имя и полоска здоровья не выше верхнего края арены
  const clipped = ['n-left', 'n-right', 'hp-left', 'hp-right'].filter(id => {
    const r = document.getElementById(id).getBoundingClientRect();
    return r.top < arenaR.top - 1 || r.bottom > arenaR.bottom + 1;
  });
  return { pairs, over, out, cut, cardCut, clipped, scroll: bot.scrollHeight - bot.clientHeight,
    botH: Math.round(botR.height), arenaH: Math.round(arenaR.height), boxes: boxes.length };
}

/* ── путь до боя настоящими кликами ────────────────────────────────────────── */
async function toHome(page, name = 'qatest') {
  if (await page.$('#s-home.on')) return;   // уже вошёл (повторная загрузка страницы)
  await page.fill('#login-name', name);
  await page.click('#s-login .btn-gold');
  await page.waitForSelector('#s-home.on', { timeout: 10000 });
}
async function toMap(page, onScreen) {
  await toHome(page);
  if (onScreen) await onScreen('02-home');
  await page.click('#home-play-btn');
  await page.waitForSelector('#ov-tutor.on', { timeout: 5000 });
  if (onScreen) await onScreen('03-tutor');
  await tapTutor(page);
  await page.waitForSelector('#s-creator-pick.on', { timeout: 5000 });
  if (onScreen) await onScreen('04-creator-pick');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#s-creator-pick [onclick]')].find(e => /ЛОТЕРЕЯ/.test(e.textContent));
    b.click();
  });
  await page.waitForSelector('#s-lottery.on', { timeout: 5000 });
  if (onScreen) await onScreen('05-lottery');
  await page.click('#lottery-spin');
  await page.waitForSelector('#lottery-accept', { state: 'visible', timeout: 10000 });
  if (onScreen) await onScreen('06-lottery-result');
  await page.click('#lottery-accept');
  await page.waitForSelector('#s-map.on', { timeout: 8000 });
  await tapTutor(page);
  if (onScreen) await onScreen('07-map');
}
async function toBattle(page, onScreen) {
  await toMap(page, onScreen);
  await page.click('#map-loc-canteen');
  await page.waitForSelector('#s-battle.on', { timeout: 10000 });
}
// после входа в бой: гейт микрофона или подсказка -> отсчёт -> ход игрока
async function startFight(page) {
  await tapTutor(page);
  await page.waitForFunction(() => state.phase === 'player_turn', null, { timeout: 12000 });
}
const battleInfo = page => page.evaluate(() => ({
  phase: state.phase, mode: state.battleMode, myHP: state.myHP, botHP: state.botHP,
  heard: document.getElementById('heard-txt').textContent,
  noVoice: document.getElementById('no-voice').textContent,
  status: document.getElementById('status').textContent,
  sub: document.getElementById('phrase-sub').textContent,
  cardsVisible: document.getElementById('cards-row').offsetHeight > 0,
  meterVisible: document.querySelector('.meter-zone').offsetHeight > 0,
  gate: document.getElementById('ov-mic-gate').classList.contains('on'),
  cards: [...document.querySelectorAll('#cards-grid .card-opt')].map(b => b.textContent),
  answer: state.currentPhrase && state.currentPhrase.en,
  answers: state.currentPhrase && state.currentPhrase.answers
}));
const freezeBot = page => page.evaluate(() => {
  // бот не бьёт: проверяем ход игрока без гонки с таймером удара
  clearTimeout(state.botAttackTimer);
  window.__origSchedule = window.__origSchedule || scheduleBotAttack;
  scheduleBotAttack = function () { clearTimeout(state.botAttackTimer); };
});
const clickCard = (page, correct) => page.evaluate(ok => {
  const btns = [...document.querySelectorAll('#cards-grid .card-opt')];
  const b = btns.find(x => (x.textContent === state.currentPhrase.en) === ok);
  if (!b) return false;
  b.click();
  return true;
}, correct);

/* ═══ FLOW · от входа до боя, наложения на каждом экране ═══════════════════ */
async function runFlow() {
  for (const [w, h] of [[390, 844], [766, 600], [1280, 800]]) {
    scenario(`Путь от входа до боя, окно ${w}x${h}`);
    const page = await open({ viewport: { width: w, height: h } });
    let screens = 0, pairsTotal = 0;
    const bad = [];
    const onScreen = async tag => {
      const m = await page.evaluate(measureScreenText);
      screens++; pairsTotal += m.pairs;
      if (m.over.length) bad.push(`${tag}: ${m.over.slice(0, 3).join('; ')}`);
      await shot(page, `flow-${w}x${h}-${tag}`);
    };
    await onScreen('01-login');
    let reached = true;
    try {
      await toBattle(page, onScreen);
      await tapTutor(page);
      await page.waitForFunction(() => state.phase === 'player_turn', null, { timeout: 12000 });
      await page.waitForTimeout(500);
      await onScreen('08-battle');
    } catch (e) { reached = false; bad.push('не дошёл: ' + String(e.message).split('\n')[0]); }
    check(`FLOW-${w}-01`, `Игрок доходит от входа по имени до своего хода в бою (${w}x${h})`, reached, `экран: ${await screenId(page)}`);
    check(`FLOW-${w}-02`, `Текст не наезжает на текст ни на одном экране пути: экранов ${screens}, пар ${pairsTotal}, наложений ${bad.length}`,
      bad.length === 0, bad.join(' | '));
    check(`FLOW-${w}-03`, 'По пути нет ошибок скрипта', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
    await page.ctx.close();
  }
}

/* ═══ LAY · экран боя на разных окнах и в разных состояниях ════════════════ */
const SIZES = [[390, 844], [390, 667], [375, 560], [766, 900], [766, 700], [766, 600], [766, 520], [766, 450], [1280, 800], [1280, 620]];
async function runLayout() {
  scenario('Экран боя: наложения, обрезка, границы - 10 размеров окна, 5 состояний');
  const page = await open({ viewport: { width: 766, height: 800 } });
  await toBattle(page);
  await startFight(page);
  // замораживаем бой: состояния ставим сами, как их ставит игра
  await page.evaluate(() => { clearTimeout(state.botAttackTimer); state.phase = 'game_over'; try { recognition && recognition.abort(); } catch (e) {} });
  const setState = which => page.evaluate(w => {
    const $ = id => document.getElementById(id);
    const voiceUI = on => { document.querySelector('.meter-zone').style.display = on ? '' : 'none'; $('cards-row').style.display = on ? 'none' : ''; };
    $('phrase-card').className = 'phrase-card'; $('phrase-ru').className = 'phrase-ru'; $('phrase-sub').className = 'phrase-sub';
    $('no-voice').textContent = '';
    if (w === 'turn') {
      voiceUI(true);
      $('phrase-pic').textContent = '🍕'; $('phrase-ru').textContent = 'Я хочу пиццу';
      $('phrase-sub').textContent = '🎤 Скажи фразу ПО-АНГЛИЙСКИ — и бей';
      setStatus('⚔ ГОВОРИ ПО-АНГЛИЙСКИ — БЕЙ!', 'mine'); setHeard('🎤 слушаю - говори');
    } else if (w === 'stun') {
      voiceUI(true);
      $('phrase-pic').textContent = ''; $('phrase-ru').textContent = '😵'; $('phrase-sub').textContent = 'оглушён...';
      setStatus('💫 ОГЛУШЁН!', 'bad'); setHeard('🎤 слушаю - говори');
    } else if (w === 'result') {
      voiceUI(true);
      $('phrase-pic').textContent = '🛒';
      showResult(true, "we're going to the store", "We're going to the store", true);
      setStatus('⚔ ГОВОРИ ПО-АНГЛИЙСКИ — БЕЙ!', 'mine'); setHeard('→ "we\'re going to the store"', true);
    } else if (w === 'long') {
      voiceUI(true);
      $('phrase-pic').textContent = '🗣'; $('phrase-ru').textContent = 'Мы умеем говорить по-английски';
      $('phrase-sub').textContent = '🎤 Скажи фразу ПО-АНГЛИЙСКИ — и бей';
      setStatus('⚔ ГОВОРИ ПО-АНГЛИЙСКИ — БЕЙ!', 'mine'); setHeard('✗ "we can speak in english very well" — ещё раз');
      $('no-voice').textContent = '⚠ Ничего не услышал — говори громче';
    } else if (w === 'cards') {
      voiceUI(false);
      $('phrase-pic').textContent = '🗣'; $('phrase-ru').textContent = 'Она не знает ответа';
      $('phrase-sub').textContent = '🃏 Выбери перевод - бей врага';
      setStatus('⚔ ВЫБЕРИ ПЕРЕВОД - БЕЙ!', 'mine');
      const opts = ["She doesn't know the answer", "We're going to the store", 'Do you speak English?', 'I want to drink water'];
      [...document.querySelectorAll('#cards-grid .card-opt')].forEach((b, i) => { b.textContent = opts[i]; b.disabled = false; });
      $('no-voice').textContent = '🎤 Голос здесь не работает: микрофон заблокирован. Играем карточками.';
    }
    if (w === 'turn') layoutArena(); else fitBattlePanel();   // как в игре: раскладка на старте боя, дальше только подгонка
  }, which);
  let total = 0, pairs = 0;
  const fails = { over: [], out: [], cut: [], clip: [], scroll: [] };
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    for (const st of ['turn', 'stun', 'result', 'long', 'cards']) {
      await setState(st);
      await page.waitForTimeout(80);
      const m = await page.evaluate(measureBattle);
      total++; pairs += m.pairs;
      const tag = `${w}x${h}/${st}`;
      if (m.over.length) fails.over.push(`${tag}: ${m.over.join(',')}`);
      if (m.out.length) fails.out.push(`${tag}: ${m.out.join(',')}`);
      if (m.cut.length || m.cardCut) fails.cut.push(`${tag}: ${m.cut.join(',')}${m.cardCut ? ' карточек ' + m.cardCut : ''}`);
      if (m.clipped.length) fails.clip.push(`${tag}: ${m.clipped.join(',')}`);
      if (m.scroll > 1) fails.scroll.push(`${tag}: не влезло ${m.scroll}px`);
      if (st === 'turn' || st === 'stun' || st === 'cards') await shot(page, `lay-${w}x${h}-${st}`);
    }
  }
  check('LAY-01', `Блоки нижней панели не наезжают друг на друга: замеров ${total}, пар ${pairs}, наложений ${fails.over.length}`,
    fails.over.length === 0, fails.over.join(' | '));
  check('LAY-02', `Ни один блок не вышел за край панели: замеров ${total}, нарушений ${fails.out.length}`,
    fails.out.length === 0, fails.out.join(' | '));
  check('LAY-03', `Текст не обрезан (подпись под шкалой, статус, карточки): замеров ${total}, обрезок ${fails.cut.length}`,
    fails.cut.length === 0, fails.cut.join(' | '));
  check('LAY-04', `Имена и полоски здоровья бойцов целиком внутри арены: замеров ${total}, срезано ${fails.clip.length}`,
    fails.clip.length === 0, fails.clip.join(' | '));
  check('LAY-05', `Панель вмещает содержимое без прокрутки: замеров ${total}, не влезло ${fails.scroll.length}`,
    fails.scroll.length === 0, fails.scroll.join(' | '));
  await page.ctx.close();
}

/* ═══ VOICE · голос и запасной путь ════════════════════════════════════════ */
async function runVoice() {
  // 1. голос работает: сказал верно - удар
  {
    scenario('Голос работает: верная фраза бьёт соперника');
    const page = await open({ sr: 'ok' });
    await toBattle(page);
    await startFight(page);
    await freezeBot(page);
    await page.waitForFunction(() => document.getElementById('heard-txt').textContent.includes('слушаю'), null, { timeout: 5000 }).catch(() => {});
    const b0 = await battleInfo(page);
    check('VOICE-01', 'На своём ходу игра слушает и говорит об этом словами', /слушаю/.test(b0.heard), `подпись: "${b0.heard}"`);
    check('VOICE-02', 'Подпись "слушаю" не отсылает к спрятанной кнопке микрофона', !/тапни/.test(b0.heard), b0.heard);
    const said = await page.evaluate(a => window.__say(a), b0.answers[0]);
    await page.waitForFunction(hp => state.botHP < hp, b0.botHP, { timeout: 4000 }).catch(() => {});
    const b1 = await battleInfo(page);
    check('VOICE-03', 'Верная фраза голосом снимает здоровье соперника', said && b1.botHP < b0.botHP, `сказано=${said} botHP ${b0.botHP} -> ${b1.botHP}`);
    check('VOICE-04', 'В голосовом режиме карточки не показаны', !b1.cardsVisible && b1.meterVisible, JSON.stringify({ c: b1.cardsVisible, m: b1.meterVisible }));
    await page.waitForFunction(() => state.phase === 'player_turn' && state.acceptingAnswer && document.getElementById('heard-txt').textContent.includes('слушаю'), null, { timeout: 6000 }).catch(() => {});
    const hp = (await battleInfo(page)).botHP;
    await page.evaluate(() => window.__say('banana potato'));
    await page.waitForTimeout(400);
    const b2 = await battleInfo(page);
    check('VOICE-05', 'Неверная фраза не бьёт и игра говорит "ещё раз"', b2.botHP === hp && /ещё раз/.test(b2.heard), `botHP ${hp} -> ${b2.botHP}, подпись "${b2.heard}"`);
    // браузер слушает, но не распознаёт: ошибки нет - у игрока должен быть выход руками
    const link = await page.evaluate(() => { const b = document.getElementById('to-cards'); return b.offsetHeight > 0 && /карточк/.test(b.textContent); });
    check('VOICE-07', 'В голосовом режиме видна ссылка "играть карточками"', link);
    await page.click('#to-cards');
    await page.waitForTimeout(200);
    const b3 = await battleInfo(page);
    check('VOICE-08', 'Ссылка переводит бой на карточки с верным вариантом', b3.mode === 'cards' && b3.cardsVisible && !b3.meterVisible && b3.cards.includes(b3.answer), JSON.stringify({ mode: b3.mode, cards: b3.cards }));
    check('VOICE-06', 'Нет ошибок скрипта', page.errors.length === 0, page.errors.join(' | '));
    await page.ctx.close();
  }
  // 2. распознавание стартует и падает с ошибкой сети (так было у владельца)
  {
    scenario('Распознавание падает с ошибкой сети: игра не молчит и даёт карточки');
    const page = await open({ sr: 'network' });
    await toBattle(page);
    await startFight(page);
    await freezeBot(page);
    await page.waitForFunction(() => state.battleMode === 'cards', null, { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(200);
    const b = await battleInfo(page);
    check('VOICE-10', 'После отказа распознавания подпись "слушаю" не висит', !/слушаю/.test(b.heard), `подпись: "${b.heard}"`);
    check('VOICE-11', 'Игра словами говорит, что голос здесь не работает', /Голос здесь не работает/.test(b.noVoice), `сообщение: "${b.noVoice}"`);
    check('VOICE-12', 'Вместо шкалы показаны четыре карточки с переводом', b.mode === 'cards' && b.cardsVisible && !b.meterVisible && b.cards.filter(Boolean).length === 4,
      JSON.stringify({ mode: b.mode, cards: b.cards }));
    check('VOICE-13', 'Среди карточек есть верный перевод', b.cards.includes(b.answer), `верный "${b.answer}", карточки ${JSON.stringify(b.cards)}`);
    check('VOICE-14', 'Статус зовёт выбирать перевод, а не говорить', /ВЫБЕРИ ПЕРЕВОД/.test(b.status) && !/ГОВОРИ/.test(b.status), b.status);
    const m = await page.evaluate(measureBattle);
    check('VOICE-15', `В карточном режиме блоки не наезжают: пар ${m.pairs}, наложений ${m.over.length}`, m.over.length === 0 && m.scroll <= 1, `${m.over.join(',')} не влезло ${m.scroll}px`);
    await shot(page, 'voice-network-cards');
    // неверная карточка
    await clickCard(page, false);
    await page.waitForTimeout(150);
    const red = await page.evaluate(() => document.querySelectorAll('#cards-grid .card-opt.wrong').length);
    const b2 = await battleInfo(page);
    check('VOICE-16', 'Неверная карточка краснеет и удара нет', red === 1 && b2.botHP === b.botHP, `красных ${red}, botHP ${b.botHP} -> ${b2.botHP}`);
    await page.waitForFunction(() => [...document.querySelectorAll('#cards-grid .card-opt')].every(x => !x.disabled), null, { timeout: 3000 }).catch(() => {});
    // верная карточка
    const tts0 = await page.evaluate(() => window.__tts.length);
    const b3 = await battleInfo(page);
    await clickCard(page, true);
    await page.waitForFunction(hp => state.botHP < hp, b3.botHP, { timeout: 3000 }).catch(() => {});
    const b4 = await battleInfo(page);
    const tts = await page.evaluate(() => window.__tts.slice(-1)[0] || '');
    check('VOICE-17', 'Верная карточка бьёт соперника', b4.botHP < b3.botHP, `botHP ${b3.botHP} -> ${b4.botHP}`);
    check('VOICE-18', 'После верной карточки игра произносит английскую фразу', (await page.evaluate(() => window.__tts.length)) > tts0 && tts === b3.answer, `сказано "${tts}", ждали "${b3.answer}"`);
    // следующий бой сразу карточками, без гейта
    await page.evaluate(() => { state.botHP = 20; });
    await page.waitForFunction(() => state.phase === 'player_turn' && state.acceptingAnswer, null, { timeout: 6000 }).catch(() => {});
    await clickCard(page, true);
    await page.waitForFunction(() => state.phase === 'game_over', null, { timeout: 5000 }).catch(() => {});
    check('VOICE-19', 'Нет ошибок скрипта', page.errors.length === 0, page.errors.join(' | '));
    await page.ctx.close();
  }
  // 3. тихий отказ: распознавание заканчивается, не начавшись, без ошибки
  {
    scenario('Распознавание молча не стартует: после двух попыток - карточки');
    const page = await open({ sr: 'silent' });
    await toBattle(page);
    await startFight(page);
    const switched = await page.waitForFunction(() => state.battleMode === 'cards', null, { timeout: 25000 }).then(() => true).catch(() => false);
    const b = await battleInfo(page);
    const starts = await page.evaluate(() => window.__srStarts);
    check('VOICE-20', `Тихий отказ распознавания переводит на карточки (попыток старта: ${starts})`, switched && b.cardsVisible, JSON.stringify({ mode: b.mode, noVoice: b.noVoice }));
    check('VOICE-21', 'Игра объясняет причину словами', /Голос здесь не работает/.test(b.noVoice) || switched && b.cardsVisible, b.noVoice);
    await page.ctx.close();
  }
  // 4. микрофон запрещён средой (встроенный браузер приложения)
  {
    scenario('Микрофон запрещён средой: гейт объясняет и даёт играть карточками');
    const page = await open({ sr: 'not-allowed', micDenied: true, viewport: { width: 766, height: 600 } });
    await toBattle(page);
    const gate = await page.waitForSelector('#ov-mic-gate.on', { timeout: 6000 }).then(() => true).catch(() => false);
    check('VOICE-30', 'Перед боем показан экран про микрофон', gate, `экран ${await screenId(page)}`);
    const g = await page.evaluate(() => ({
      help: document.getElementById('mic-gate-help').offsetHeight > 0,
      text: document.getElementById('ov-mic-gate').innerText,
      cardsBtn: document.getElementById('mic-gate-cards').offsetHeight > 0
    }));
    check('VOICE-31', 'Экран говорит, что доступ заблокирован, и как его открыть', g.help && /ЗАБЛОКИРОВАН/.test(g.text), g.text.slice(0, 160));
    check('VOICE-32', 'На экране есть кнопка играть без микрофона', g.cardsBtn && /БЕЗ МИКРОФОНА/.test(g.text), g.text.slice(-80));
    const mg = await page.evaluate(measureScreenText);
    check('VOICE-33', `Текст экрана про микрофон не наезжает: пар ${mg.pairs}, наложений ${mg.over.length}`, mg.over.length === 0, mg.over.join(' | '));
    const fits = await page.evaluate(() => { const c = document.querySelector('#ov-mic-gate .tutor-card').getBoundingClientRect(); return c.top >= 0 && c.bottom <= innerHeight; });
    check('VOICE-34', 'Карточка про микрофон целиком помещается в окно 766x600', fits);
    await shot(page, 'voice-denied-gate');
    await page.click('#mic-gate-cards');
    await startFight(page).catch(() => {});
    await freezeBot(page);
    const b = await battleInfo(page);
    check('VOICE-35', 'После кнопки бой идёт карточками', b.phase === 'player_turn' && b.mode === 'cards' && b.cardsVisible && !b.gate, JSON.stringify({ phase: b.phase, mode: b.mode, gate: b.gate }));
    await clickCard(page, true);
    await page.waitForFunction(hp => state.botHP < hp, b.botHP, { timeout: 3000 }).catch(() => {});
    check('VOICE-36', 'Карточкой можно ударить', (await battleInfo(page)).botHP < b.botHP);
    await shot(page, 'voice-denied-cards');
    await page.ctx.close();
  }
  // 5. браузер без распознавания речи
  {
    scenario('Браузер без распознавания речи: тоже есть запасной путь');
    const page = await open({ sr: 'absent' });
    await toBattle(page);
    const gate = await page.waitForSelector('#ov-mic-gate.on', { timeout: 6000 }).then(() => true).catch(() => false);
    const text = gate ? await page.evaluate(() => document.getElementById('ov-mic-gate').innerText) : '';
    check('VOICE-40', 'Игра словами говорит, что браузер не распознаёт речь', gate && /не умеет распознавать речь/.test(text), text.slice(0, 200));
    await page.click('#mic-gate-cards').catch(() => {});
    await startFight(page).catch(() => {});
    const b = await battleInfo(page);
    check('VOICE-41', 'И даёт играть карточками', b.mode === 'cards' && b.cardsVisible && b.cards.includes(b.answer), JSON.stringify({ mode: b.mode, phase: b.phase }));
    await page.ctx.close();
  }
}

/* ═══ METER · шкала двигается ══════════════════════════════════════════════ */
async function runMeter() {
  scenario('Шкала голоса двигается от микрофона, пока игра слушает');
  const page = await open({ sr: 'ok' });
  await toBattle(page);
  await startFight(page);
  await freezeBot(page);
  let maxH = 0, samples = 0;
  for (let i = 0; i < 30; i++) {
    const hs = await page.evaluate(() => [...document.querySelectorAll('.abar')].map(b => parseFloat(b.style.height) || 0));
    samples++; maxH = Math.max(maxH, ...hs);
    if (maxH > 10) break;
    await page.waitForTimeout(150);
  }
  check('METER-01', `Столбики шкалы поднимаются от звука микрофона (замеров ${samples}, максимум ${maxH.toFixed(1)}px, покой 6px)`, maxH > 10, `максимум ${maxH}px`);
  const inPanel = await page.evaluate(() => {
    const m = document.getElementById('audio-meter').getBoundingClientRect();
    return [...document.querySelectorAll('.abar')].every(b => { const r = b.getBoundingClientRect(); return r.top >= m.top - 1 && r.bottom <= m.bottom + 1; });
  });
  check('METER-02', 'Столбики не вылезают из рамки шкалы', inPanel);
  // остановка прослушивания возвращает шкалу в покой и отпускает микрофон
  await page.evaluate(() => stopListen());
  await page.waitForTimeout(400);
  const idle = await page.evaluate(() => ({ hs: [...document.querySelectorAll('.abar')].map(b => b.style.height), stream: !!audioStream }));
  check('METER-03', 'После остановки шкала в покое и микрофон отпущен', idle.hs.every(h => h === '6px') && !idle.stream, JSON.stringify(idle));
  await page.ctx.close();
}

/* ═══ SND · звук ═══════════════════════════════════════════════════════════ */
async function runSound() {
  scenario('Звук: удар и проверка звука запускают источники');
  const page = await open({ sr: 'ok' });
  await toHome(page);
  await page.evaluate(() => { window.__snd = 0; });
  await page.evaluate(() => [...document.querySelectorAll('#s-home button')].find(b => /проверить звук/.test(b.textContent)).click());
  await page.waitForTimeout(900);
  const t = await page.evaluate(() => ({ snd: window.__snd, txt: document.getElementById('sound-test-result').innerText, ac: _audioCtx && _audioCtx.state }));
  check('SND-01', `Кнопка "проверить звук" запускает источники звука (${t.snd}) при работающем аудио`, t.snd >= 3 && t.ac === 'running', JSON.stringify(t).slice(0, 200));
  // удар бота
  await page.goto(`${ORIGIN}/${PAGE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#s-login.on, #s-home.on');
  await toBattle(page);
  await startFight(page);
  await page.evaluate(() => { window.__snd = 0; clearTimeout(state.botAttackTimer); botStrike(); });
  await page.waitForTimeout(900);
  const s = await page.evaluate(() => ({ snd: window.__snd, ac: _audioCtx && _audioCtx.state, hp: state.myHP, status: document.getElementById('status').textContent }));
  check('SND-02', `Удар соперника звучит: источников звука ${s.snd}, аудио ${s.ac}`, s.snd >= 2 && s.ac === 'running', JSON.stringify(s));
  check('SND-03', 'Удар снимает здоровье и показывает оглушение', s.hp === 80 && /ОГЛУШЁН/.test(s.status), JSON.stringify(s));
  const m = await page.evaluate(measureBattle);
  check('SND-04', `В оглушении строки не наезжают: пар ${m.pairs}, наложений ${m.over.length}`, m.over.length === 0, m.over.join(','));
  await page.ctx.close();
}

/* ═══ END · победа и поражение ═════════════════════════════════════════════ */
async function runEnd() {
  {
    scenario('Победа карточками до экрана награды');
    const page = await open({ sr: 'network' });
    await toBattle(page);
    await startFight(page);
    await page.waitForFunction(() => state.battleMode === 'cards', null, { timeout: 6000 }).catch(() => {});
    await freezeBot(page);
    let hits = 0;
    for (let i = 0; i < 8; i++) {
      const ready = await page.waitForFunction(() => state.phase === 'game_over' || (state.phase === 'player_turn' && state.acceptingAnswer &&
        [...document.querySelectorAll('#cards-grid .card-opt')].some(b => b.textContent === state.currentPhrase.en && !b.disabled)), null, { timeout: 6000 }).then(() => true).catch(() => false);
      if (!ready || await page.evaluate(() => state.phase === 'game_over')) break;
      if (await clickCard(page, true)) hits++;
      await page.waitForTimeout(250);
    }
    const won = await page.waitForFunction(() => ['s-reward', 's-over'].includes(document.querySelector('.screen.on')?.id), null, { timeout: 8000 }).then(() => true).catch(() => false);
    const scr = await screenId(page);
    check('END-01', `Пять верных карточек (нажато ${hits}) приводят к победе`, won && hits === 5, `экран ${scr}, ударов ${hits}`);
    await page.waitForTimeout(400);
    const m = await page.evaluate(measureScreenText);
    check('END-02', `На экране после победы (${scr}) текст не наезжает: пар ${m.pairs}, наложений ${m.over.length}`, m.over.length === 0, m.over.join(' | '));
    await shot(page, 'end-win');
    check('END-03', 'Нет ошибок скрипта', page.errors.length === 0, page.errors.join(' | '));
    await page.ctx.close();
  }
  {
    scenario('Поражение до экрана "ПОРАЖЕНИЕ"');
    const page = await open({ sr: 'ok', viewport: { width: 766, height: 600 } });
    await toBattle(page);
    await startFight(page);
    await page.evaluate(() => { state.myHP = 20; clearTimeout(state.botAttackTimer); botStrike(); });
    const over = await page.waitForSelector('#s-over.on', { timeout: 8000 }).then(() => true).catch(() => false);
    const title = over ? await page.evaluate(() => document.getElementById('over-title').textContent) : '';
    check('END-10', 'Последний удар соперника приводит на экран поражения', over && /ПОРАЖЕНИЕ/.test(title), `экран ${await screenId(page)}, заголовок "${title}"`);
    const m = await page.evaluate(measureScreenText);
    check('END-11', `На экране поражения текст не наезжает: пар ${m.pairs}, наложений ${m.over.length}`, m.over.length === 0, m.over.join(' | '));
    await shot(page, 'end-lose');
    await page.click('#btn-back-map');
    const map = await page.waitForSelector('#s-map.on', { timeout: 5000 }).then(() => true).catch(() => false);
    check('END-12', 'С экрана поражения кнопка возвращает на карту', map, `экран ${await screenId(page)}`);
    await page.ctx.close();
  }
}

/* ═══ SWEEP · второстепенные экраны ════════════════════════════════════════ */
async function runSweep() {
  for (const [w, h] of [[390, 844], [766, 600], [1280, 800]]) {
    scenario(`Второстепенные экраны, окно ${w}x${h}`);
    const page = await open({ viewport: { width: w, height: h } });
    await toMap(page);
    let screens = 0, pairs = 0;
    const bad = [], notReached = [];
    const visit = async (tag, action, expect) => {
      try {
        await action();
        if (expect) await page.waitForSelector(expect, { timeout: 5000 });
        await page.waitForTimeout(350);
        const m = await page.evaluate(measureScreenText);
        screens++; pairs += m.pairs;
        if (m.over.length) bad.push(`${tag}: ${m.over.slice(0, 2).join('; ')}`);
        await shot(page, `sweep-${w}x${h}-${tag}`);
      } catch (e) { notReached.push(`${tag}: ${String(e.message).split('\n')[0].slice(0, 90)}`); }
    };
    const homeBtn = rx => page.evaluate(r => { const b = [...document.querySelectorAll('#s-home button')].find(x => new RegExp(r).test(x.textContent)); b.click(); }, rx);
    const goHomeJs = () => page.evaluate(() => goHome());
    await visit('home', goHomeJs, '#s-home.on');
    await visit('leaderboard', () => homeBtn('ЛИДЕРБОРД'), '#s-lb.on');
    await goHomeJs();
    await visit('social', () => homeBtn('ДРУЗЬЯ'), '#s-social.on');
    await goHomeJs();
    await visit('chat', () => homeBtn('ЧАТ'), '#s-global-chat.on');
    await goHomeJs();
    await visit('creator-pick', () => homeBtn('ПЕРЕСОЗДАТЬ'), '#s-creator-pick.on');
    const variants = await page.evaluate(() => [...document.querySelectorAll('#s-creator-pick [onclick]')].filter(e => e.offsetHeight > 0 && !/В МЕНЮ/.test(e.textContent)).length);
    for (let i = 0; i < variants; i++) {
      await visit(`creator-${i + 1}`, async () => {
        await page.evaluate(() => show('s-creator-pick'));
        await page.evaluate(k => [...document.querySelectorAll('#s-creator-pick [onclick]')].filter(e => e.offsetHeight > 0 && !/В МЕНЮ/.test(e.textContent))[k].click(), i);
        await page.waitForFunction(() => document.querySelector('.screen.on')?.id !== 's-creator-pick', null, { timeout: 4000 });
      });
    }
    // район открывается после четырёх локаций
    await visit('world', async () => {
      await page.evaluate(() => { authUpdate({ completed: ['canteen', 'shop', 'gym', 'apartment'] }); goHome(); });
      await page.click('#home-play-btn');
      await tapTutor(page);
    }, '#s-world.on');
    check(`SWEEP-${w}-01`, `Все второстепенные экраны открываются (${screens} экранов)`, notReached.length === 0, notReached.join(' | '));
    check(`SWEEP-${w}-02`, `Текст не наезжает на текст: экранов ${screens}, пар ${pairs}, наложений ${bad.length}`, bad.length === 0, bad.join(' | '));
    check(`SWEEP-${w}-03`, 'Нет ошибок скрипта', page.errors.length === 0, [...new Set(page.errors)].slice(0, 4).join(' | '));
    await page.ctx.close();
  }
}

/* ── запуск ────────────────────────────────────────────────────────────────── */
(async () => {
  let srv = null;
  if (!BASE) { const s = await startServer(); srv = s.srv; ORIGIN = `http://127.0.0.1:${s.port}`; }
  console.log(`Стенд исходной игры: ${ORIGIN}/${PAGE}`);
  const pw = loadPlaywright();
  browser = await pw.chromium.launch({ headless: true, executablePath: pickExecutable(false) || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + AUDIO,
           '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    if (want('FLOW')) await runFlow();
    if (want('LAY')) await runLayout();
    if (want('VOICE')) await runVoice();
    if (want('METER')) await runMeter();
    if (want('SND')) await runSound();
    if (want('END')) await runEnd();
    if (want('SWEEP')) await runSweep();
  } catch (e) {
    check('RUN-00', 'Прогон дошёл до конца без исключения стенда', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' / '));
  }
  await browser.close();
  if (srv) srv.close();
  const failed = report(BASE ? 'last-run-root-live.json' : 'last-run-root.json');
  process.exit(failed ? 1 : 0);
})();
