const http = require('http');
const express = require('express');
const { Server, Room } = require('@colyseus/core');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Schema, MapSchema, type } = require('@colyseus/schema');
const { monitor } = require('@colyseus/monitor');
const { PHRASES, checkAnswer } = require('./phrases');

// ─── ELO ───
function eloDelta(myElo, oppElo, won, k = 32) {
  const expected = 1 / (1 + Math.pow(10, (oppElo - myElo) / 400));
  const actual = won ? 1 : 0;
  return Math.round(k * (actual - expected));
}
// in-memory leaderboard: username → { elo, char, level, wins, losses, lastSeen }
const LEADERBOARD = new Map();
function updateLeaderboard(username, payload) {
  if (!username || username === 'BOT') return;
  const prev = LEADERBOARD.get(username) || {};
  LEADERBOARD.set(username, { ...prev, ...payload, lastSeen: Date.now() });
  // cap to top 500 by elo (memory hygiene)
  if (LEADERBOARD.size > 500) {
    const sorted = [...LEADERBOARD.entries()].sort((a, b) => (b[1].elo || 0) - (a[1].elo || 0));
    LEADERBOARD.clear();
    sorted.slice(0, 500).forEach(([k, v]) => LEADERBOARD.set(k, v));
  }
}

// ─── STATE SCHEMAS ───
class Player extends Schema {}
type('string')(Player.prototype, 'name');
type('string')(Player.prototype, 'char');
type('number')(Player.prototype, 'level');
type('number')(Player.prototype, 'elo');
type('number')(Player.prototype, 'hp');
type('boolean')(Player.prototype, 'isActive');
type('boolean')(Player.prototype, 'isBot');

class FightState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
type({ map: Player })(FightState.prototype, 'players');
type('string')(FightState.prototype, 'phase');      // waiting | countdown | turn | hit | miss | game_over
type('string')(FightState.prototype, 'phraseRu');
type('string')(FightState.prototype, 'phraseEn');
type('string')(FightState.prototype, 'difficulty'); // easy | medium | hard
type('number')(FightState.prototype, 'turnEndsAt');
type('string')(FightState.prototype, 'winnerId');

// ─── FIGHT ROOM ───
class FightRoom extends Room {
  onCreate(opts) {
    this.maxClients = 2;
    this.bracket = opts.bracket || 1;          // skill bracket — see computeBracket
    this.state = new FightState();
    this.state.phase = 'waiting';
    this.state.difficulty = 'easy';
    // ELO seed: easier difficulty for bracket 1, harder for bracket 2
    if (this.bracket >= 2) this.state.difficulty = 'medium';
    this.usedIds = new Set();
    this.correctCount = 0;
    this.turnTimeout = null;
    this.botFillTimeout = null;
    this.setMetadata({ bracket: this.bracket });
    this.onMessage('answer', (client, msg) => this.handleAnswer(client, msg));
    this.onMessage('leave', (client) => this.disconnect());
    console.log(`[room ${this.roomId}] created (bracket ${this.bracket})`);

    // bot-fill after 30 seconds if no opponent joins
    this.botFillTimeout = setTimeout(() => {
      if (this.state.players.size < 2 && this.state.phase === 'waiting') {
        this.addBot();
      }
    }, 30000);
  }

  onJoin(client, opts) {
    const p = new Player();
    p.name  = (opts.name || 'Anon').slice(0, 16);
    p.char  = opts.char || 'subzero';
    p.level = Math.max(1, Math.min(10, opts.level || 1));
    p.elo   = Math.max(0, Math.min(3000, opts.elo || 1000));
    p.hp    = 100;
    p.isActive = false;
    p.isBot = false;
    this.state.players.set(client.sessionId, p);
    console.log(`[room ${this.roomId}] joined: ${p.name} elo=${p.elo}`);
    if (this.state.players.size === 2) {
      clearTimeout(this.botFillTimeout);
      this.startCountdown();
    }
  }

  addBot() {
    const bot = new Player();
    const botChars = ['subzero','kotal','sareena','nightwolf'];
    bot.name  = 'BOT';
    bot.char  = botChars[Math.floor(Math.random() * botChars.length)];
    bot.level = this.bracket >= 2 ? 7 : 3;
    // bot elo scales with bracket
    bot.elo   = this.bracket >= 2 ? 1300 : 1000;
    bot.hp    = 100;
    bot.isActive = false;
    bot.isBot = true;
    const botId = 'bot_' + Math.random().toString(36).slice(2, 8);
    this.state.players.set(botId, bot);
    this.botId = botId;
    console.log(`[room ${this.roomId}] bot fill: ${bot.char} elo=${bot.elo}`);
    this.startCountdown();
  }

  startCountdown() {
    this.state.phase = 'countdown';
    // pick who goes first
    const ids = Array.from(this.state.players.keys());
    const firstId = ids[Math.floor(Math.random() * ids.length)];
    ids.forEach(id => {
      const p = this.state.players.get(id);
      p.isActive = (id === firstId);
    });
    setTimeout(() => this.startTurn(), 3500);
  }

  pickPhrase() {
    const pool = PHRASES[this.state.difficulty] || PHRASES.easy;
    const avail = pool.filter(p => !this.usedIds.has(p.id));
    const src = avail.length ? avail : pool;
    if (!avail.length) this.usedIds.clear();
    const phrase = src[Math.floor(Math.random() * src.length)];
    this.usedIds.add(phrase.id);
    this.currentPhrase = phrase;
    this.state.phraseRu = phrase.ru;
    this.state.phraseEn = phrase.en;
  }

  startTurn() {
    this.pickPhrase();
    this.state.phase = 'turn';
    this.state.turnEndsAt = Date.now() + 8000;
    clearTimeout(this.turnTimeout);
    this.turnTimeout = setTimeout(() => this.onTimeout(), 8000);
    // if bot's turn → it answers automatically
    const activeId = this.getActiveId();
    const active = this.state.players.get(activeId);
    if (active && active.isBot) {
      const skill = 0.55;
      const correct = Math.random() < skill;
      const said = correct
        ? this.currentPhrase.en
        : ['umm','huh','i dont know','what'][Math.floor(Math.random() * 4)];
      setTimeout(() => this.resolveAnswer(activeId, said, correct), 1500 + Math.random() * 1500);
    }
  }

  getActiveId() {
    for (const [id, p] of this.state.players) {
      if (p.isActive) return id;
    }
    return null;
  }

  handleAnswer(client, msg) {
    if (this.state.phase !== 'turn') return;
    const active = this.state.players.get(client.sessionId);
    if (!active || !active.isActive) return;
    const spoken = (msg.alts && msg.alts[0]) || msg.text || '';
    // SERVER-AUTHORITATIVE validation
    const correct = (msg.alts || [msg.text || '']).some(a => checkAnswer(a, this.currentPhrase.answers));
    this.resolveAnswer(client.sessionId, spoken, correct);
  }

  resolveAnswer(playerId, spoken, correct) {
    clearTimeout(this.turnTimeout);
    const player = this.state.players.get(playerId);
    if (!player) return;
    if (correct) {
      this.correctCount++;
      // damage opponent
      const oppId = this.getOpponentId(playerId);
      const opp = this.state.players.get(oppId);
      if (opp) opp.hp = Math.max(0, opp.hp - 20);
      this.state.phase = 'hit';
      this.broadcast('result', { correct: true, playerId, spoken, answer: this.currentPhrase.en });
      if (opp && opp.hp <= 0) {
        setTimeout(() => this.endFight(playerId), 1500);
        return;
      }
      // upgrade difficulty
      if (this.correctCount === 6 && this.state.difficulty === 'easy') {
        this.state.difficulty = 'medium';
        this.broadcast('diff_up', { level: 'medium' });
      } else if (this.correctCount === 14 && this.state.difficulty === 'medium') {
        this.state.difficulty = 'hard';
        this.broadcast('diff_up', { level: 'hard' });
      }
    } else {
      this.state.phase = 'miss';
      this.broadcast('result', { correct: false, playerId, spoken, answer: this.currentPhrase.en });
    }
    setTimeout(() => this.swap(), 2200);
  }

  onTimeout() {
    if (this.state.phase !== 'turn') return;
    const activeId = this.getActiveId();
    if (!activeId) return;
    this.resolveAnswer(activeId, '(no answer)', false);
  }

  getOpponentId(playerId) {
    for (const id of this.state.players.keys()) {
      if (id !== playerId) return id;
    }
    return null;
  }

  swap() {
    for (const p of this.state.players.values()) {
      p.isActive = !p.isActive;
    }
    this.startTurn();
  }

  endFight(winnerId) {
    clearTimeout(this.turnTimeout);
    this.state.phase = 'game_over';
    this.state.winnerId = winnerId;
    const winner = this.state.players.get(winnerId);
    const loserId = this.getOpponentId(winnerId);
    const loser = this.state.players.get(loserId);
    // compute ELO delta (server-authoritative)
    let deltaWinner = 0, deltaLoser = 0, winnerNewElo = 0, loserNewElo = 0;
    if (winner && loser) {
      deltaWinner = eloDelta(winner.elo, loser.elo, true);
      deltaLoser  = eloDelta(loser.elo, winner.elo, false);
      winnerNewElo = Math.max(0, winner.elo + deltaWinner);
      loserNewElo  = Math.max(0, loser.elo  + deltaLoser);
      // persist to in-memory leaderboard (skip bots)
      if (!winner.isBot) {
        updateLeaderboard(winner.name, { elo: winnerNewElo, char: winner.char, level: winner.level, wins: (LEADERBOARD.get(winner.name)?.wins || 0) + 1 });
      }
      if (!loser.isBot) {
        updateLeaderboard(loser.name, { elo: loserNewElo, char: loser.char, level: loser.level, losses: (LEADERBOARD.get(loser.name)?.losses || 0) + 1 });
      }
    }
    this.broadcast('game_over', {
      winnerId,
      winnerName: winner ? winner.name : '?',
      elo: {
        [winnerId]: { delta: deltaWinner, newElo: winnerNewElo },
        [loserId]:  { delta: deltaLoser,  newElo: loserNewElo },
      },
    });
    setTimeout(() => this.disconnect(), 5000);
  }

  onLeave(client, consented) {
    console.log(`[room ${this.roomId}] left: ${client.sessionId}`);
    if (this.state.phase !== 'game_over') {
      // opponent left mid-fight — auto-win for remaining
      const remaining = Array.from(this.state.players.keys()).find(id => id !== client.sessionId);
      if (remaining) {
        const remP = this.state.players.get(remaining);
        if (remP && !remP.isBot) this.endFight(remaining);
      }
    }
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    console.log(`[room ${this.roomId}] disposed`);
    clearTimeout(this.turnTimeout);
    clearTimeout(this.botFillTimeout);
  }
}

// ─── BOOT ───
const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});
app.get('/', (_, res) => res.send('English Kombat PvP server — ok'));
app.get('/health', (_, res) => res.send('ok'));
app.get('/leaderboard', (_, res) => {
  const top = [...LEADERBOARD.entries()]
    .map(([name, p]) => ({ name, ...p }))
    .sort((a, b) => (b.elo || 0) - (a.elo || 0))
    .slice(0, 50);
  res.json({ top });
});
app.use('/colyseus', monitor());

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// .filterBy(['bracket']) → Colyseus auto-matches clients to rooms with same bracket
gameServer.define('fight', FightRoom).filterBy(['bracket']);

const PORT = process.env.PORT || 2567;
gameServer.listen(PORT).then(() => {
  console.log(`⚔  Colyseus PvP server listening on :${PORT}`);
});
