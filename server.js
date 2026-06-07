const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('ok'));

// ── PHRASE BANK ───────────────────────────────────────────────────
const PHRASES = {
  easy: [
    { id:1,  ru:'Я хочу есть',           en:'I want to eat',          answers:['i want to eat','i wanna eat','i want food'] },
    { id:2,  ru:'Я могу говорить',        en:'I can speak',            answers:['i can speak','i can talk','i am able to speak'] },
    { id:3,  ru:'Я знаю английский',      en:'I know English',         answers:['i know english','i speak english'] },
    { id:4,  ru:'Я хочу спать',           en:'I want to sleep',        answers:['i want to sleep','i wanna sleep','i need to sleep'] },
    { id:5,  ru:'Я не знаю',             en:"I don't know",           answers:["i don't know","i do not know",'i dunno'] },
    { id:6,  ru:'Это хорошо',            en:"It's good",              answers:["it's good",'it is good','this is good','that is good'] },
    { id:7,  ru:'Я иду домой',           en:"I'm going home",         answers:["i'm going home",'i am going home','i go home'] },
    { id:8,  ru:'Дай мне воды',          en:'Give me water',          answers:['give me water','give me some water'] },
    { id:9,  ru:'Я устал',              en:"I'm tired",              answers:["i'm tired",'i am tired'] },
    { id:10, ru:'Помоги мне',            en:'Help me',                answers:['help me','please help me'] },
  ],
  medium: [
    { id:101, ru:'Я знаю немецкий',        en:'I know German',          answers:['i know german','i speak german'] },
    { id:102, ru:'Я знаю французский',     en:'I know French',          answers:['i know french','i speak french'] },
    { id:103, ru:'Он хочет есть',          en:'He wants to eat',        answers:['he wants to eat'] },
    { id:104, ru:'Я хочу пить воду',       en:'I want to drink water',  answers:['i want to drink water','i want water'] },
    { id:105, ru:'Я могу помочь тебе',     en:'I can help you',         answers:['i can help you'] },
    { id:106, ru:'Это очень хорошо',       en:"It's very good",         answers:["it's very good",'this is very good','that is very good'] },
    { id:107, ru:'Она умеет готовить',     en:'She can cook',           answers:['she can cook','she knows how to cook'] },
    { id:108, ru:'Мы идём в магазин',      en:"We're going to the store", answers:["we're going to the store",'we are going to the store','we go to the store'] },
    { id:109, ru:'Я хочу выиграть',        en:'I want to win',          answers:['i want to win'] },
    { id:110, ru:'Ты говоришь по-английски?', en:'Do you speak English?', answers:['do you speak english'] },
  ],
  hard: [
    { id:201, ru:'Я хотел бы поесть',             en:"I'd like to eat",             answers:["i'd like to eat",'i would like to eat'] },
    { id:202, ru:'Я не могу этого сделать',        en:"I can't do it",               answers:["i can't do it","i cannot do this","i can't do that"] },
    { id:203, ru:'Ты должен учиться',              en:'You must study',              answers:['you must study','you should study','you need to study','you have to study'] },
    { id:204, ru:'Мне нужна помощь',              en:'I need help',                 answers:['i need help','i need some help'] },
    { id:205, ru:'Она не знает ответа',            en:"She doesn't know the answer", answers:["she doesn't know the answer","she does not know the answer"] },
    { id:206, ru:'Мы умеем говорить по-английски', en:'We can speak English',        answers:['we can speak english','we speak english'] },
    { id:207, ru:'Я учу английский каждый день',   en:'I study English every day',   answers:['i study english every day','i learn english every day'] },
    { id:208, ru:'Где здесь туалет?',             en:'Where is the bathroom?',      answers:['where is the bathroom','where is the toilet'] },
  ],
};

// ── HELPERS ───────────────────────────────────────────────────────
function genCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => ch[Math.floor(Math.random() * ch.length)]).join('');
}

function norm(t) {
  return String(t).toLowerCase().replace(/[.,!?;:'"()\-]/g,'').replace(/\s+/g,' ').trim();
}

function levenshtein(a, b) {
  if (a === b)     return 0;
  if (!a.length)   return b.length;
  if (!b.length)   return a.length;
  const dp = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i-1] === b[j-1] ? prev : Math.min(prev, dp[j], dp[j-1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

function check(spoken, answers) {
  const s = norm(spoken);
  const stop = new Set(['a','an','the','to','of','in','i','it','is','am','are','was','were','be']);

  return answers.some(a => {
    const n = norm(a);

    // 1. exact match
    if (s === n) return true;

    // 2. spoken contains the full answer (user added extra words)
    if (s.includes(n)) return true;

    // 3. keyword coverage — 75%+ of content words from answer must appear in spoken
    const kw = n.split(' ').filter(w => w.length > 1 && !stop.has(w));
    if (!kw.length) return false;
    const hit = kw.filter(w => s.includes(w)).length;
    if (hit / kw.length >= 0.75) return true;

    // 4. reverse check — if spoken keywords are mostly in the answer
    //    (user said the right words but maybe skipped articles)
    const skw = s.split(' ').filter(w => w.length > 1 && !stop.has(w));
    if (skw.length > 0) {
      const revHit = skw.filter(w => n.includes(w)).length;
      if (revHit / skw.length >= 0.85 && skw.length >= Math.max(1, kw.length - 1)) return true;
    }

    // 5. Levenshtein — typo/mishearing tolerance (e.g. "i won to eat" vs "i want to eat")
    const dist   = levenshtein(s, n);
    const maxLen = Math.max(s.length, n.length);
    if (maxLen > 0 && dist / maxLen <= 0.22) return true;  // ≤22% chars different

    // 6. per-word fuzzy — at least 75% of content words match within 2 char edits
    if (kw.length > 0 && skw.length > 0) {
      const fuzzyHit = kw.filter(k =>
        skw.some(w => levenshtein(k, w) <= Math.max(1, Math.floor(k.length / 4)))
      ).length;
      if (fuzzyHit / kw.length >= 0.75) return true;
    }

    return false;
  });
}

function pickPhrase(difficulty, usedIds) {
  const pool = PHRASES[difficulty] || PHRASES.easy;
  const avail = pool.filter(p => !usedIds.has(p.id));
  const src = avail.length ? avail : pool;
  if (!avail.length) pool.forEach(p => usedIds.delete(p.id));
  return src[Math.floor(Math.random() * src.length)];
}

// ── GAME ROOM ─────────────────────────────────────────────────────
class Room {
  constructor(id) {
    this.id = id;
    this.players = {};        // socketId → { name, hp, isActive }
    this.order   = [];        // [p1Id, p2Id]
    this.phase   = 'waiting';
    this.phrase  = null;
    this.used    = new Set();
    this.correct = 0;
    this.diff    = 'easy';
    this.timer   = null;
    this.rematch = new Set();
  }

  add(sid, name) {
    this.players[sid] = { name, hp: 100, isActive: false };
    this.order.push(sid);
    if (this.order.length === 2) this.countdown();
  }

  countdown() {
    this.phase = 'countdown';
    this.push('state', this.pub());
    setTimeout(() => this.turn(), 3600);
  }

  turn() {
    this.phrase = pickPhrase(this.diff, this.used);
    this.used.add(this.phrase.id);
    this.phase = 'player_turn';
    this.push('state', this.pub());
    this.timer = setTimeout(() => {
      if (this.phase !== 'player_turn') return;
      this.phase = 'miss';
      this.push('state', this.pub());
      this.push('result', { correct: false, spoken: '(нет ответа)', answer: this.phrase.en });
      setTimeout(() => this.swap(), 1300);
    }, 12000);
  }

  submit(sid, alts) {
    if (this.phase !== 'player_turn' || this.active() !== sid) return;
    clearTimeout(this.timer);
    const ok = (alts || []).some(a => check(a, this.phrase.answers));
    const spoken = (alts || [])[0] || '';
    // debug — see in server console what browser sends vs correct answer
    console.log(`[answer] heard: ${JSON.stringify(alts)} | correct: ${this.phrase.answers[0]} | ok: ${ok}`);

    if (ok) {
      this.correct++;
      this.upgradeDiff();
      const opp = this.opponent(sid);
      this.players[opp].hp = Math.max(0, this.players[opp].hp - 20);
      this.phase = 'hit';
      this.push('state', this.pub());
      this.push('result', { correct: true, spoken, answer: this.phrase.en });
      if (this.players[opp].hp <= 0) {
        setTimeout(() => {
          this.phase = 'game_over';
          this.push('state', this.pub());
          this.push('game_over', { winnerId: sid, winnerName: this.players[sid].name });
        }, 1000);
      } else {
        setTimeout(() => this.swap(), 1300);
      }
    } else {
      this.phase = 'miss';
      this.push('state', this.pub());
      this.push('result', { correct: false, spoken, answer: this.phrase.en });
      setTimeout(() => this.swap(), 1300);
    }
  }

  swap() {
    this.order.forEach(id => { this.players[id].isActive = !this.players[id].isActive; });
    this.turn();
  }

  upgradeDiff() {
    if (this.correct === 6  && this.diff === 'easy')   { this.diff = 'medium'; this.push('diff_up', { level:'medium' }); }
    if (this.correct === 14 && this.diff === 'medium')  { this.diff = 'hard';   this.push('diff_up', { level:'hard'   }); }
  }

  doRematch(sid) {
    this.rematch.add(sid);
    if (this.rematch.size >= this.order.length) {
      this.order.forEach(id => { this.players[id].hp = 100; this.players[id].isActive = false; });
      this.used.clear(); this.correct = 0; this.diff = 'easy'; this.rematch.clear();
      this.countdown();
    } else {
      this.push('rematch_vote', { votes: this.rematch.size });
    }
  }

  leave(sid) {
    clearTimeout(this.timer);
    delete this.players[sid];
    this.push('opp_left', {});
  }

  active()        { return this.order.find(id => this.players[id]?.isActive); }
  opponent(sid)   { return this.order.find(id => id !== sid); }
  push(ev, data)  { io.to(this.id).emit(ev, data); }

  pub() {
    return {
      phase:  this.phase,
      players: this.players,
      order:  this.order,
      phrase: this.phase === 'player_turn' ? { ru: this.phrase.ru } : null,
      diff:   this.diff,
    };
  }
}

// ── ROOM MAP ──────────────────────────────────────────────────────
const rooms  = new Map();  // code → Room
const p2room = new Map();  // socketId → code

function cleanup(sid) {
  const code = p2room.get(sid);
  if (!code) return;
  const r = rooms.get(code);
  if (r) {
    r.leave(sid);
    if (!Object.keys(r.players).length) rooms.delete(code);
  }
  p2room.delete(sid);
}

// ── SOCKET ────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('create', ({ name }) => {
    let code;
    do { code = genCode(); } while (rooms.has(code));
    const r = new Room(code);
    rooms.set(code, r);
    p2room.set(socket.id, code);
    socket.join(code);
    socket.emit('created', { code });
    r.add(socket.id, name);
  });

  socket.on('join', ({ code, name }) => {
    const c = String(code).toUpperCase().trim();
    const r = rooms.get(c);
    if (!r)                                  { socket.emit('err', 'Комната не найдена'); return; }
    if (Object.keys(r.players).length >= 2)  { socket.emit('err', 'Комната заполнена');  return; }
    p2room.set(socket.id, c);
    socket.join(c);
    socket.emit('joined', { code: c });   // first — so client shows battle screen
    r.add(socket.id, name);               // triggers countdown broadcast
  });

  socket.on('answer', ({ alts }) => {
    const r = rooms.get(p2room.get(socket.id));
    if (r) r.submit(socket.id, alts);
  });

  socket.on('rematch', () => {
    const r = rooms.get(p2room.get(socket.id));
    if (r) r.doRematch(socket.id);
  });

  socket.on('leave',      () => cleanup(socket.id));
  socket.on('disconnect', () => cleanup(socket.id));
});

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`⚔  English Kombat → http://localhost:${PORT}`));
