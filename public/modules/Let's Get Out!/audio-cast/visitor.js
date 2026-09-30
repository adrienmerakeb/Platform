(() => {
'use strict';
const API='/api/audio-cast';
const $=id=>document.getElementById(id);
let cameraStream=null, scanTimer=null, active=null, muted=false, heartbeatTimer=null, audioListener=null;

function message(text,error=false){$('acVisitorMessage').innerHTML=text?`<div class="ac-alert ${error?'error':''}">${text}</div>`:''}
function openModal(id){$(id).classList.add('open');$(id).setAttribute('aria-hidden','false')}
function closeModal(id){$(id).classList.remove('open');$(id).setAttribute('aria-hidden','true')}
async function api(path,options={}){
  const r=await fetch(API+path,{credentials:'include',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw Object.assign(new Error(data.error||'Audio Cast request failed.'),{status:r.status,data});
  return data;
}
function decodePayload(raw){
  const text=String(raw||'').trim();
  if(!text.startsWith('LGOAC1:')) throw new Error('This is not an LGO Audio Cast QR code.');
  const encoded=text.slice(7).replaceAll('-','+').replaceAll('_','/');
  const json=decodeURIComponent(Array.from(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,'='))).map(c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join(''));
  const payload=JSON.parse(json);
  if(payload.schema!=='lgo-audio-cast-join-v1'||!payload.session_id||!payload.join_token) throw new Error('Incomplete Audio Cast QR code.');
  return payload;
}
async function nativeJoin(payload){
  const plugin=window.Capacitor?.Plugins?.LgoAudioCastClient;
  if(!plugin?.join) return {transportMode:payload.transport?.mode||'browser',signalQuality:'GOOD'};
  const result=await plugin.join({payload});
  if(plugin.addListener){
    audioListener=await plugin.addListener('stateChanged',event=>renderNative(event));
  }
  return result||{};
}
function renderNative(event={}){
  if(event.signalQuality) $('acSignal').textContent=event.signalQuality;
  if(Number.isFinite(Number(event.latencyMs))) $('acLatency').textContent=Math.round(Number(event.latencyMs))+' ms';
  if(event.transportMode) $('acTransport').textContent=event.transportMode;
  if(Number.isFinite(Number(event.audioLevel))) $('acAudioLevel').style.width=Math.max(0,Math.min(100,Number(event.audioLevel)*100))+'%';
  if(event.state==='DISCONNECTED'||event.state==='ENDED') disconnectUi('Session ended');
}
async function join(raw){
  const payload=typeof raw==='string'?decodePayload(raw):raw;
  $('acScannerStatus').textContent='Authorizing session…';
  const joined=await api('/visitor/join',{method:'POST',body:JSON.stringify({session_id:payload.session_id,join_token:payload.join_token})});
  $('acScannerStatus').textContent='Connecting to guide audio…';
  let native;
  try{
    native=await nativeJoin(payload);
  }catch(err){
    await api(`/visitor/sessions/${encodeURIComponent(payload.session_id)}/leave`,{method:'POST',body:'{}'}).catch(()=>{});
    throw err;
  }
  active={...joined,payload};
  closeScanner();
  $('acVisitorIdle').hidden=true;$('acVisitorConnected').hidden=false;
  $('acSessionTitle').textContent=joined.session.title;
  $('acGuideName').textContent=`Guide: ${joined.session.guide_name||'LGO guide'}`;
  $('acSessionState').textContent=joined.session.status;
  $('acListenerId').textContent=joined.participant_id.slice(0,8);
  $('acSignal').textContent=native.signalQuality||'GOOD';
  $('acLatency').textContent=Number.isFinite(Number(native.latencyMs))?Math.round(Number(native.latencyMs))+' ms':'—';
  $('acTransport').textContent=native.transportMode||payload.transport?.mode||'local';
  startHeartbeat();
}
async function heartbeat(){
  if(!active)return;
  const plugin=window.Capacitor?.Plugins?.LgoAudioCastClient;
  let metrics={};
  try{if(plugin?.snapshot)metrics=await plugin.snapshot()}catch{}
  try{
    const result=await api(`/visitor/sessions/${encodeURIComponent(active.session.session_id)}/heartbeat`,{
      method:'POST',
      body:JSON.stringify({
        signal_quality:metrics.signalQuality||$('acSignal').textContent,
        latency_ms:metrics.latencyMs,
        jitter_ms:metrics.jitterMs,
        transport_mode:metrics.transportMode||active.payload.transport?.mode
      })
    });
    $('acSessionState').textContent=result.session_status;
  }catch(err){
    if(err.status===403||err.status===410){disconnectUi(err.message);return}
  }
}
function startHeartbeat(){clearInterval(heartbeatTimer);heartbeatTimer=setInterval(heartbeat,5000);heartbeat()}
async function leave(){
  if(!active)return disconnectUi();
  try{await api(`/visitor/sessions/${encodeURIComponent(active.session.session_id)}/leave`,{method:'POST',body:'{}'})}catch{}
  try{await window.Capacitor?.Plugins?.LgoAudioCastClient?.leave?.()}catch{}
  disconnectUi();
}
function disconnectUi(reason=''){
  clearInterval(heartbeatTimer);heartbeatTimer=null;
  active=null;$('acVisitorConnected').hidden=true;$('acVisitorIdle').hidden=false;
  if(reason)message(reason,true);
}
async function resumeExisting(){
  try{
    const data=await api('/visitor/sessions/current');
    if(!data.session)return;
    active={participant_id:data.session.participant_id,session:{
      session_id:data.session.session_id,title:data.session.title,status:data.session.session_status,
      guide_name:data.session.guide_name,participant_limit:data.session.participant_limit
    },payload:{transport:{mode:data.session.transport_mode}}};
    $('acVisitorIdle').hidden=true;$('acVisitorConnected').hidden=false;
    $('acSessionTitle').textContent=data.session.title;
    $('acGuideName').textContent=`Guide: ${data.session.guide_name||'LGO guide'}`;
    $('acSessionState').textContent=data.session.session_status;
    $('acListenerId').textContent=data.session.participant_id.slice(0,8);
    $('acSignal').textContent=data.session.signal_quality||'—';
    $('acLatency').textContent=data.session.latency_ms?Math.round(data.session.latency_ms)+' ms':'—';
    $('acTransport').textContent=data.session.transport_mode||'local';
    startHeartbeat();
  }catch{}
}
async function openScanner(){
  const nativeScanner=window.Capacitor?.Plugins?.LgoAudioCastClient;
  if(nativeScanner?.scanQr){
    try{
      const result=await nativeScanner.scanQr();
      if(result?.value){await join(result.value);return}
    }catch{}
  }
  openModal('acScannerModal');$('acScannerStatus').textContent='Point the camera at the guide\'s QR code.';
  try{
    cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    $('acCamera').srcObject=cameraStream;await $('acCamera').play();
    if('BarcodeDetector' in window){
      const detector=new BarcodeDetector({formats:['qr_code']});
      const tick=async()=>{
        if(!cameraStream)return;
        try{
          const codes=await detector.detect($('acCamera'));
          if(codes[0]?.rawValue){await join(codes[0].rawValue);return}
        }catch{}
        scanTimer=requestAnimationFrame(tick);
      };
      scanTimer=requestAnimationFrame(tick);
    }else{
      $('acScannerStatus').textContent='Automatic QR recognition is unavailable on this device. Paste the session code below.';
    }
  }catch(err){$('acScannerStatus').textContent='Camera unavailable. Paste the session code below.'}
}
function closeScanner(){
  if(scanTimer)cancelAnimationFrame(scanTimer);scanTimer=null;
  if(cameraStream){cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null}
  $('acCamera').srcObject=null;closeModal('acScannerModal');
}
$('acBack').onclick=()=>history.back();
$('acHelp').onclick=()=>openModal('acHelpModal');
$('acCloseHelp').onclick=()=>closeModal('acHelpModal');
$('acScan').onclick=openScanner;$('acCloseScanner').onclick=closeScanner;
$('acJoinManual').onclick=()=>join($('acManualCode').value).catch(err=>$('acScannerStatus').textContent=err.message);
$('acLeave').onclick=leave;
$('acMute').onclick=async()=>{
  muted=!muted;$('acMute').textContent=muted?'Unmute':'Mute locally';
  try{await window.Capacitor?.Plugins?.LgoAudioCastClient?.setMuted?.({muted})}catch{}
};
resumeExisting();
})();