'use strict';
const finite=n=>typeof n==='number'&&Number.isFinite(n);
function netWorth(state,dataset){
  if(finite(state?.netWorth)&&state.netWorth>=0)return{value:state.netWorth,exact:true,source:'GSI'};
  if(!finite(state?.gold)||state.gold<0||state.dataQuality?.inventory!==true||!Array.isArray(state.inventory)||!state.inventory.length)return{value:null,exact:false,source:'Нет данных'};
  let value=state.gold,unknown=0;
  for(const item of state.inventory){if(/^neutral/.test(item.slot||''))continue;const price=dataset.items?.[item.name]?.cost;if(finite(price))value+=price;else unknown++;}
  return{value:unknown?null:value,exact:false,source:unknown?'Нет полных данных':'Инвентарь + золото',caveat:unknown?'Не все предметы найдены в справочнике':'Примерно: не включает предметы курьера, поглощённые улучшения и расходование зарядов'};
}
function assessFarm(state,dataset,settings,history=[]){
  const nw=netWorth(state,dataset),time=finite(state?.gameTime)?Math.max(0,state.gameTime):null;
  const goal=Math.max(10,Math.min(150,Number(settings.farmTarget10)||50));
  const target=time===null?null:Math.round(goal*Math.min(time,600)/600);
  const lh=finite(state?.lastHits)?state.lastHits:null;
  const sample=history.filter(p=>p.gameTime>=585&&p.gameTime<=615&&finite(p.lastHits)&&(time===null||p.gameTime<=time)).sort((a,b)=>Math.abs(a.gameTime-600)-Math.abs(b.gameTime-600))[0];
  const measured=time>600?(finite(sample?.lastHits)?sample.lastHits:null):lh;
  const expected=time>600?goal:target;
  const ratio=measured===null||!expected?null:measured/expected;
  const status=ratio===null?'unknown':ratio<.8?'behind':ratio>1.2?'ahead':'on_track';
  let rate=null;const prior=[...history].reverse().find(p=>time!==null&&p.gameTime<=time-120&&p.gameTime>=time-240&&finite(p.lastHits));
  if(prior&&lh!==null&&time>prior.gameTime&&lh>=prior.lastHits)rate=Math.round((lh-prior.lastHits)/(time-prior.gameTime)*60*10)/10;
  return{netWorth:nw,lastHits:lh,denies:state?.denies??null,gpm:state?.gpm??null,target10:goal,currentTarget:target,checkpoint10:sample||null,rate,status,source:'Личная цель',label:time>600?'Результат к 10 минуте':'Прогресс к 10 минуте',comparison:measured===null?'Недостаточно данных':`${Math.round(measured)} / ${expected} LH`,reason:'Настраиваемая личная цель, не среднее профессиональных игроков'};
}
function addHistory(history,state){
  if(!finite(state?.gameTime)||state.gameTime<0||!finite(state?.lastHits))return history;
  const last=history.at(-1);if(last&&state.gameTime<last.gameTime-60)return[];
  if(last&&state.gameTime-last.gameTime<10)return history;
  const all=[...history,{gameTime:state.gameTime,lastHits:state.lastHits,netWorth:state.netWorth??null,deaths:state.deaths??null}];
  const retained=all.slice(-180);
  for(const minute of[10,20,30]){
    const nearest=all.filter(point=>Math.abs(point.gameTime-minute*60)<=15&&finite(point.lastHits)).sort((a,b)=>Math.abs(a.gameTime-minute*60)-Math.abs(b.gameTime-minute*60))[0];
    if(nearest&&!retained.some(point=>point.gameTime===nearest.gameTime))retained.push(nearest);
  }
  return retained.sort((a,b)=>a.gameTime-b.gameTime);
}
module.exports={netWorth,assessFarm,addHistory};
