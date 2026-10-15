'use strict';
function capturePolicy(settings,state,{now=Date.now(),calibrating=false,visible=true,imported=false}={}){
  const profile=['economy','balanced','gsi'].includes(settings.performanceMode)?settings.performanceMode:'economy';
  const intervalMs=profile==='balanced'?2500:5000;
  if(!settings.captureEnabled||profile==='gsi')return{enabled:false,intervalMs,reason:'Режим GSI · захват выключен'};
  if(settings.demo||imported)return{enabled:false,intervalMs,reason:'Захват приостановлен для примера'};
  if(calibrating)return{enabled:true,intervalMs:5000,reason:'Проверка HUD'};
  if(!visible)return{enabled:false,intervalMs,reason:'Оверлей скрыт · захват приостановлен'};
  if(!state?.isSpectator&&Number.isFinite(state?.receivedAt)&&now-state.receivedAt>=-1000&&now-state.receivedAt<15000&&['DOTA_GAMERULES_STATE_HERO_SELECTION','DOTA_GAMERULES_STATE_STRATEGY_TIME'].includes(state.gameState)&&settings.captureScope==='game')return{enabled:true,intervalMs,reason:'Пик · распознавание выбранных портретов'};
  if(settings.autoLane===true&&settings.captureScope==='game')return{enabled:true,intervalMs,reason:'Распознавание видимых героев по экрану'};
  if(!state?.isWraithKing||state.isSpectator||!Number.isFinite(state.receivedAt)||now-state.receivedAt>12000)return{enabled:false,intervalMs,reason:'Ожидаю активный матч Wraith King'};
  if(state.isPaused||!['DOTA_GAMERULES_STATE_GAME_IN_PROGRESS','DOTA_GAMERULES_STATE_PRE_GAME'].includes(state.gameState))return{enabled:false,intervalMs,reason:'Матч не идёт · захват приостановлен'};
  return{enabled:true,intervalMs,reason:'Захват HUD активен'};
}
module.exports={capturePolicy};
