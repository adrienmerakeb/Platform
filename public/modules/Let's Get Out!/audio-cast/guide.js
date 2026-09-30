(() => {
'use strict';
const API='/api/audio-cast';
const $=id=>document.getElementById(id);
let me=null, subscription=null, session=null, transport=null, rosterTimer=null, elapsedTimer=null, audioListener=null, startedAt=null;

function openModal(id){$(id).classList.add('open');$(id).setAttribute('aria-hidden','false')}
function closeModal(id){$(id).classList.remove('open');$(id).setAttribute('aria-hidden','true')}
async function api(path,options={}){
  const r=await fetch(API+path,{credentials:'include',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw Object.assign(new Error(data.error||'Audio Cast request failed.'),{status:r.status,data});
  return data;
}
async function getMe(){const r=await fetch('/api/me',{credentials:'include'});if(!r.ok)throw new Error('Sign in required.');return (await r.json()).user}
function setPill(el,text,kind=''){el.textContent=text;el.className='ac-pill'+(kind?' '+kind:'')}
async function init(){
  try{
    me=await getMe();
    if(me.role!=='visitor'){ $('acProfileCopy').textContent='Audio Cast guide tools require a visitor account.'; return }
    if(!me.has_guide_profile){
      $('acProfileCopy').textContent='Activate your guide profile to subscribe to Audio Cast.';
      $('acActivateGuide').hidden=false;return;
    }
    $('acProfileCopy').textContent='Guide profile active.';
    await loadSubscription();
  }catch(err){$('acProfileCopy').textContent=err.message}
}
async function activateGuide(){
  const data=await api('/guide/profile/activate',{method:'POST',body:'{}'});
  me={...me,...data.user};$('acActivateGuide').hidden=true;$('acProfileCopy').textContent='Guide profile active.';
  await loadSubscription();
}
async function loadSubscription(){
  $('acSubscriptionCard').hidden=false;
  subscription=await api('/guide/subscription');
  const active=['active','trialing'].includes(String(subscription.status).toLowerCase());
  setPill($('acSubStatus'),active?'Active subscription':subscription.status||'Inactive',active?'good':'warn');
  $('acSubscribe').textContent=active?'Subscription active':'Subscribe — €25/month + VAT';
  if(active){$('acCreateCard').hidden=false;await recoverSession()}
}
async function subscribe(){
  if(['active','trialing'].includes(String(subscription?.status).toLowerCase()))return;
  const data=await api('/guide/subscription/checkout',{method:'POST',body:'{}'});
  location.href=data.checkout_url;
}
async function confirmCheckout(){
  const q=new URLSearchParams(location.search);
  if(q.get('checkout')!=='success'||!q.get('session_id'))return;
  try{await api('/guide/subscription/confirm?session_id='+encodeURIComponent(q.get('session_id')))}finally{
    history.replaceState({},'',location.pathname);
  }
}
async function recoverSession(){
  const data=await api('/guide/sessions/current');
  if(data.session){session=data.session;showSession();await prepareTransport(true);startPolling()}
}
async function createSession(){
  const data=await api('/guide/sessions',{method:'POST',body:JSON.stringify({
    title:$('acTitle').value||'Live Audio Cast',participant_limit:Number($('acLimit').value)||25
  })});
  session=data.session;showSession();startPolling();
}
function showSession(){
  $('acCreateCard').hidden=true;$('acSessionCard').hidden=false;$('acListenersCard').hidden=false;
  $('acHostTitle').textContent=session.title;
  $('acListenerCount').textContent=`${session.participant_count||0} / ${session.participant_limit}`;
  renderState(session.status);
  startedAt=session.started_at?new Date(session.started_at):null;startElapsed();
}
function renderState(state){
  const map={READY:['Ready','warn'],ACTIVE:['Live','good'],PAUSED:['Paused','warn'],INTERRUPTED:['Interrupted','bad'],ENDED:['Ended','bad']};
  const [label,kind]=map[state]||[state,''];setPill($('acHostState'),label,kind);
  $('acStart').textContent=state==='PAUSED'||state==='INTERRUPTED'?'Resume broadcast':'Start broadcast';
  $('acStart').disabled=!transport||state==='ACTIVE'||state==='ENDED';
  $('acPause').disabled=state!=='ACTIVE';
}
async function createNativeTransport(){
  const plugin=window.Capacitor?.Plugins?.LgoAudioCastHost;
  if(plugin?.prepare){
    const result=await plugin.prepare({sessionId:session.session_id,participantLimit:session.participant_limit});
    return result.transport||result;
  }
  return {mode:'internet-fallback',host:location.hostname,port:Number(location.port)||443,protocol:location.protocol.replace(':','')};
}
async function prepareTransport(recovery=false){
  if(!session)return;
  try{
    transport=await createNativeTransport();
    const q=await api(`/guide/sessions/${encodeURIComponent(session.session_id)}/qr`,{
      method:'POST',body:JSON.stringify({transport})
    });
    $('acQr').src=q.qr_data_url;$('acQr').hidden=false;
    $('acQrHelp').textContent=recovery?'Recovered session QR — visitors already connected do not need to rescan.':'Visitors scan this QR from My live guidings.';
    $('acHostSignal').textContent=transport.mode||'local';
    renderState(session.status);
  }catch(err){$('acQrHelp').textContent=err.message}
}
async function setState(state){
  const data=await api(`/guide/sessions/${encodeURIComponent(session.session_id)}/state`,{
    method:'PATCH',body:JSON.stringify({state})
  });
  session={...session,...data.session};renderState(session.status);
}
async function start(){
  const plugin=window.Capacitor?.Plugins?.LgoAudioCastHost;
  try{
    if(plugin?.start)await plugin.start({sessionId:session.session_id});
    if(session.status==='READY'||session.status==='PAUSED'||session.status==='INTERRUPTED')await setState('ACTIVE');
    startedAt=startedAt||new Date();setPill($('acMicState'),'Microphone live','good');
  }catch(err){setPill($('acMicState'),'Microphone error','bad');alert(err.message)}
}
async function pause(){
  try{await window.Capacitor?.Plugins?.LgoAudioCastHost?.pause?.();await setState('PAUSED');setPill($('acMicState'),'Microphone paused','warn')}catch(err){alert(err.message)}
}
async function end(){
  if(!confirm('End this Audio Cast session? Its QR code will stop working permanently.'))return;
  try{await window.Capacitor?.Plugins?.LgoAudioCastHost?.end?.()}catch{}
  await setState('ENDED');clearInterval(rosterTimer);clearInterval(elapsedTimer);
  $('acQr').hidden=true;$('acListenersCard').hidden=true;$('acSessionCard').hidden=true;$('acCreateCard').hidden=false;
  session=null;transport=null;
}
function startElapsed(){
  clearInterval(elapsedTimer);
  const tick=()=>{if(!startedAt)return $('acElapsed').textContent='00:00';const s=Math.max(0,Math.floor((Date.now()-startedAt)/1000));$('acElapsed').textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`};
  tick();elapsedTimer=setInterval(tick,1000);
}
async function refreshRoster(){
  if(!session)return;
  try{
    const data=await api(`/guide/sessions/${encodeURIComponent(session.session_id)}/participants`);
    const connected=data.participants.filter(p=>p.status==='CONNECTED');
    $('acListenerCount').textContent=`${connected.length} / ${session.participant_limit}`;
    const lat=connected.map(p=>Number(p.latency_ms)).filter(Number.isFinite);
    $('acHostLatency').textContent=lat.length?Math.round(lat.reduce((a,b)=>a+b,0)/lat.length)+' ms':'—';
    const roster=$('acRoster');roster.replaceChildren();
    if(!data.participants.length){roster.innerHTML='<div class="ac-empty">No listeners connected yet.</div>';return}
    data.participants.forEach(p=>{
      const item=document.createElement('div');item.className='ac-listener';
      const copy=document.createElement('div');copy.className='ac-listener-copy';
      const title=document.createElement('strong');title.textContent=`Listener ${p.participant_id.slice(0,8)}`;
      const meta=document.createElement('small');meta.textContent=`${p.status} · ${p.signal_quality||'signal —'} · ${p.latency_ms?Math.round(p.latency_ms)+' ms':'latency —'}`;
      copy.append(title,meta);item.append(copy);
      if(p.status==='CONNECTED'){
        const kick=document.createElement('button');kick.className='ac-btn danger';kick.textContent='Remove';
        kick.onclick=()=>kickListener(p.participant_id);item.append(kick);
      }
      roster.append(item);
    });
  }catch{}
}
async function kickListener(id){
  if(!confirm('Remove this listener from the session?'))return;
  await api(`/guide/sessions/${encodeURIComponent(session.session_id)}/participants/${encodeURIComponent(id)}/kick`,{method:'POST',body:'{}'});
  refreshRoster();
}
function startPolling(){clearInterval(rosterTimer);refreshRoster();rosterTimer=setInterval(refreshRoster,3000)}
function bindNative(){
  const plugin=window.Capacitor?.Plugins?.LgoAudioCastHost;
  if(plugin?.addListener){
    plugin.addListener('stateChanged',event=>{
      if(event.signalQuality)$('acHostSignal').textContent=event.signalQuality;
      if(Number.isFinite(Number(event.audioLevel)))$('acMicLevel').style.width=Math.max(0,Math.min(100,Number(event.audioLevel)*100))+'%';
      if(event.state==='INTERRUPTED'&&session?.status==='ACTIVE')setState('INTERRUPTED').catch(()=>{});
    }).then(x=>audioListener=x).catch(()=>{});
  }
}
$('acBack').onclick=()=>history.back();$('acHelp').onclick=()=>openModal('acHelpModal');$('acCloseHelp').onclick=()=>closeModal('acHelpModal');
$('acActivateGuide').onclick=activateGuide;$('acSubscribe').onclick=subscribe;$('acCreateSession').onclick=createSession;
$('acPrepare').onclick=()=>prepareTransport(false);$('acStart').onclick=start;$('acPause').onclick=pause;$('acEnd').onclick=end;$('acRefresh').onclick=refreshRoster;
(async()=>{await confirmCheckout();await init();bindNative()})();
})();