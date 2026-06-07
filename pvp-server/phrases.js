// Same phrase pool as client — keep in sync
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
  ],
};

function norm(t) {
  return String(t).toLowerCase().replace(/[.,!?;:'"()\-]/g,'').replace(/\s+/g,' ').trim();
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
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
function checkAnswer(spoken, answers) {
  const s = norm(spoken);
  const stop = new Set(['a','an','the','to','of','in','i','it','is','am','are','was','were','be']);
  return answers.some(a => {
    const n = norm(a);
    if (s === n) return true;
    if (s.includes(n)) return true;
    const kw = n.split(' ').filter(w => w.length > 1 && !stop.has(w));
    if (!kw.length) return false;
    if (kw.filter(w => s.includes(w)).length / kw.length >= 0.75) return true;
    const skw = s.split(' ').filter(w => w.length > 1 && !stop.has(w));
    if (skw.length > 0) {
      const rev = skw.filter(w => n.includes(w)).length;
      if (rev / skw.length >= 0.85 && skw.length >= Math.max(1, kw.length - 1)) return true;
    }
    const d = levenshtein(s, n);
    if (Math.max(s.length, n.length) > 0 && d / Math.max(s.length, n.length) <= 0.22) return true;
    if (kw.length > 0 && skw.length > 0) {
      const fz = kw.filter(k => skw.some(w => levenshtein(k, w) <= Math.max(1, Math.floor(k.length / 4)))).length;
      if (fz / kw.length >= 0.75) return true;
    }
    return false;
  });
}

module.exports = { PHRASES, checkAnswer };
