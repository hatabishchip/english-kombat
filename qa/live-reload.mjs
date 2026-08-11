import { loadPlaywright, pickExecutable } from './harness.mjs';
const B='https://english-kombat.vercel.app/island/index.html';
const pw=loadPlaywright();
const br=await pw.chromium.launch({ executablePath:pickExecutable(false), headless:true });
const ctx=await br.newContext();
// засеять «онбординг пройден» ДО любых скриптов страницы - как реально вернувшийся игрок
await ctx.addInitScript(()=>{
  try{
    if(!localStorage.getItem('ek_island_v1')) localStorage.setItem('ek_island_v1', JSON.stringify({
      name:'Тест', onbDone:true, quizSent:true, permGranted:true, permAsked:true,
      level:'advanced', track:'advanced', goal:'🌴 Путешествия', daily:'10',
      locIdx:0, locDone:0, xp:0, ammo:0, coins:0, streak:1,
      lastDay:new Date().toISOString().slice(0,10)
    }));
  }catch(e){}
});
const pg=await ctx.newPage();
const errs=[]; pg.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); });
await pg.goto(B,{waitUntil:'domcontentloaded',timeout:30000});
const onMap=await pg.waitForSelector('#s-map.on',{timeout:12000}).then(()=>true).catch(()=>false);
const inOnb=await pg.$('#s-onb.on').then(e=>!!e).catch(()=>false);
await pg.waitForTimeout(1500);
const diag=await pg.evaluate(()=>{
  let s=null; try{ s=JSON.parse(localStorage.getItem('ek_island_v1')); }catch(e){}
  return { onbDone:s&&s.onbDone, name:s&&s.name, screensOn:[...document.querySelectorAll('.screen.on')].map(x=>x.id) };
});
console.log(JSON.stringify({landedOnMap:onMap, stuckInOnboarding:inOnb, ...diag, consoleErrors:errs.slice(0,3)},null,2));
await br.close();
