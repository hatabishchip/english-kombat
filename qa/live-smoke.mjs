import { loadPlaywright, pickExecutable } from './harness.mjs';
const pw=loadPlaywright();
const br=await pw.chromium.launch({ executablePath:pickExecutable(false), headless:true });
const ctx=await br.newContext();
await ctx.addInitScript(()=>{ try{ if(!localStorage.getItem('ek_island_v1')) localStorage.setItem('ek_island_v1', JSON.stringify({permGranted:true,permAsked:true})); }catch(e){} });
const pg=await ctx.newPage();
const errs=[]; let sends=0, payload=null;
pg.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); });
pg.on('request',r=>{ if(r.url().includes('/api/island/quiz-result')){ sends++; try{payload=JSON.parse(r.postData()||'{}');}catch(e){} } });
const has=async rx=>pg.evaluate(r=>new RegExp(r).test(document.querySelector('#chatScroll').innerText), rx);
// кружок: тап; если следующий шаг сам не пришёл - дожать «Дальше»
async function circle(nextRx){
  const n=await pg.evaluate(()=>document.querySelectorAll('#chatScroll .vcircle').length);
  await pg.waitForFunction(k=>document.querySelectorAll('#chatScroll .vcircle').length>=k, n||1, {timeout:25000});
  const c=await pg.$$('#chatScroll .vcircle'); await c[c.length-1].click();
  await pg.waitForFunction(r=>new RegExp(r).test(document.querySelector('#chatScroll').innerText)
    || [...document.querySelectorAll('#onbQuick .chip')].some(x=>/Дальше/.test(x.textContent)), nextRx, {timeout:40000});
  if(!(await has(nextRx))){
    const chips=await pg.$$('#onbQuick .chip');
    for(const ch of chips){ if(/Дальше/.test(await ch.textContent())){ await ch.click(); break; } }
    await pg.waitForFunction(r=>new RegExp(r).test(document.querySelector('#chatScroll').innerText), nextRx, {timeout:25000});
  }
}
async function pick(rx){
  await pg.waitForFunction(r=>new RegExp(r).test(document.querySelector('#chatScroll').innerText), rx, {timeout:25000});
  await pg.waitForFunction(()=>document.querySelectorAll('#onbQuick .chip').length>0,null,{timeout:25000});
  const c=await pg.$$('#onbQuick .chip'); await c[0].click();
}
await pg.goto('https://english-kombat.vercel.app/island/index.html',{waitUntil:'domcontentloaded',timeout:30000});
await pg.waitForSelector('#s-onb.on',{timeout:20000});
await circle('зовут');
await pg.fill('#onbInput','Тестер'); await pg.press('#onbInput','Enter');
await pick('Для чего');
await pick('Сколько времени');
await circle('изучал английский');
await pick('изучал английский');
await circle('Вопрос 1 из');
for(let i=1;i<=6;i++){
  await pg.waitForFunction(n=>new RegExp('Вопрос '+n+' из').test(document.querySelector('#chatScroll').innerText),i,{timeout:25000});
  const c=await pg.$$('#onbQuick .chip'); await c[0].click();
}
await pg.waitForSelector('#bigStart',{timeout:20000});
const fin=(await pg.evaluate(()=>document.querySelector('#chatScroll').innerText)).slice(-230);
await pg.click('#bigStart');
const onMap=await pg.waitForSelector('#s-map.on',{timeout:15000}).then(()=>true).catch(()=>false);
await pg.waitForTimeout(1500);
await pg.reload({waitUntil:'domcontentloaded'});
const backMap=await pg.waitForSelector('#s-map.on',{timeout:15000}).then(()=>true).catch(()=>false);
await pg.waitForTimeout(1500);
console.log(JSON.stringify({
  попал_на_карту:onMap, после_перезапуска_на_карте:backMap,
  отправок_аналитики:sends, маршрут:payload&&(payload.track||payload.level), верных:payload&&payload.correctCount,
  итог:fin.replace(/\n+/g,' | ').slice(-190), ошибки_консоли:errs.slice(0,3)
},null,2));
await br.close();
