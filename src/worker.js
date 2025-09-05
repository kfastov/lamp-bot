export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // health
    if (url.pathname === "/") return new Response("ok");

    // токен жив?
    if (url.pathname === "/selftest") {
      const r = await fetch("https://api.iot.yandex.net/v1.0/user/info", {
        headers: { Authorization: `Bearer ${env.YANDEX_TOKEN}` }
      });
      return json({ yandex_status: r.status });
    }

    // мини-приложение
    if (url.pathname === "/app") {
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // API: состояние
    if (url.pathname === "/api/state" && request.method === "GET") {
      const st = await getState(env);
      if (!st) return json({ ok: false }, 503);
      return json({ ok: true, ...st });
    }

    // API: действие
    if (url.pathname === "/api/action" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok:false, error:"bad_json" }, 400); }

      const actions = [];
      if (typeof body.on === "boolean") {
        actions.push({ type:"devices.capabilities.on_off", state:{ instance:"on", value: body.on } });
      }
      if (Number.isFinite(body.brightness)) {
        const v = Math.max(1, Math.min(100, Math.round(body.brightness)));
        actions.push({ type:"devices.capabilities.range", state:{ instance:"brightness", value: v } });
      }
      if (Number.isFinite(body.temperature_k)) {
        const v = Math.max(2700, Math.min(6500, Math.round(body.temperature_k)));
        actions.push({ type:"devices.capabilities.color_setting", state:{ instance:"temperature_k", value: v } });
      }
      if (!actions.length) return json({ ok:false, error:"no_actions" }, 400);

      const res = await yaAction(env, actions);
      return json(res);
    }

    // Telegram webhook
    if (url.pathname === "/tg" && request.method === "POST") {
      const hdrSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (hdrSecret !== env.TG_SECRET) return new Response("forbidden", { status: 403 });

      let u; try { u = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      const msg = u?.message; const text = msg?.text?.trim() || ""; const chatId = msg?.chat?.id;

      if (env.ALLOWED_CHAT_ID && String(chatId) !== String(env.ALLOWED_CHAT_ID)) {
        await sendTG(env, chatId, "🚫 Не авторизован."); return new Response("ok");
      }

      const [cmd, arg1] = text.split(/\s+/, 2);
      let reply = "Команды: /on /off /bri 1-100 /temp 2700-6500 /scene night|reading /id /ping";
      let actions = null;

      if (cmd === "/id") reply = `🆔 chat_id: ${chatId}`;
      else if (cmd === "/ping") {
        const r = await fetch("https://api.iot.yandex.net/v1.0/user/info", { headers:{ Authorization:`Bearer ${env.YANDEX_TOKEN}` } });
        reply = `pong. yandex_status=${r.status}`;
      }
      else if (cmd === "/on") { actions = [{ type:"devices.capabilities.on_off", state:{ instance:"on", value:true }}]; reply = "✅ Включаю"; }
      else if (cmd === "/off"){ actions = [{ type:"devices.capabilities.on_off", state:{ instance:"on", value:false }}]; reply = "✅ Выключаю"; }
      else if (cmd === "/bri") {
        const v = clampInt(arg1, 1, 100);
        reply = v!=null?`🔆 Яркость ${v}%`:"Использование: /bri 1-100";
        if (v!=null) actions = [{ type:"devices.capabilities.range", state:{ instance:"brightness", value:v }}];
      } else if (cmd === "/temp") {
        const v = clampInt(arg1, 2700, 6500);
        reply = v!=null?`🌡️ Теплота ${v}K`:"Использование: /temp 2700-6500";
        if (v!=null) actions = [{ type:"devices.capabilities.color_setting", state:{ instance:"temperature_k", value:v }}];
      } else if (cmd === "/scene") {
        const scene = (arg1 || "").toLowerCase();
        if (["night","reading"].includes(scene)) { actions = [{ type:"devices.capabilities.color_setting", state:{ instance:"scene", value: scene }}]; reply = `🎨 Сцена: ${scene}`; }
        else reply = "Доступные: night, reading";
      }

      if (actions) {
        const res = await yaAction(env, actions);
        if (!res.ok) reply = `❌ Yandex IoT error: HTTP ${res.status}\n${(res.body||'').slice(0,180)}`;
      }
      await sendTG(env, chatId, reply);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
};

// helpers
function clampInt(s, lo, hi){ const v = parseInt(s||"",10); if(!Number.isFinite(v)) return null; return Math.max(lo, Math.min(hi, v)); }
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers:{ "content-type":"application/json" } }); }

async function getState(env){
  const r = await fetch("https://api.iot.yandex.net/v1.0/user/info", { headers:{ Authorization:`Bearer ${env.YANDEX_TOKEN}` } });
  if (!r.ok) return null;
  const data = await r.json();
  const d = (data.devices||[]).find(x => x.id === env.YANDEX_DEVICE_ID);
  if (!d) return null;
  const map = { on:true, brightness:100, temperature_k:2700 };
  for (const c of d.capabilities||[]) {
    if (c.type==="devices.capabilities.on_off" && c.state) map.on = !!c.state.value;
    if (c.type==="devices.capabilities.range" && c.state?.instance==="brightness") map.brightness = c.state.value;
    if (c.type==="devices.capabilities.color_setting" && c.state?.instance==="temperature_k") map.temperature_k = c.state.value;
  }
  return map;
}

async function yaAction(env, actions){
  const r = await fetch("https://api.iot.yandex.net/v1.0/devices/actions", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${env.YANDEX_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify({ devices:[{ id: env.YANDEX_DEVICE_ID, actions }] })
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text };
}

async function sendTG(env, chatId, text){
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return r.ok;
}

// =========== мини-приложение ===========
const APP_HTML = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Lamp Control</title>
<style>
  :root { --bg:#0b0f14; --panel:#121820; --text:#d8e1ea; --muted:#8ea0b3; --accent:#2dd4bf; --track:#2a3240; --thumb:#e5eef7; }
  *{box-sizing:border-box} html,body{height:100%;margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--text);background:radial-gradient(60% 60% at 50% 20%, #0d1420 0%, var(--bg) 60%)}
  .wrap{min-height:100%;display:grid;grid-template-rows:1fr auto}
  .grid{display:grid;gap:24px;padding:24px 20px 100px;grid-template-columns:1fr 1fr;align-items:center;justify-items:center}
  .card{width:min(420px,90vw);background:linear-gradient(180deg,#121820aa,#10151d);border:1px solid #233042;border-radius:20px;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.35), inset 0 1px 0 #203047}
  h1{font-size:18px;margin:0 0 6px;font-weight:600;letter-spacing:.3px}.sub{color:var(--muted);font-size:13px;margin-bottom:16px}
  .sliders{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:6px 8px 2px}
  .vslider{display:grid;grid-template-rows:auto 1fr auto;gap:10px;place-items:center}
  .label{font-size:13px;color:var(--muted)} .value{font-size:20px;font-weight:600}
  /* iOS-like vertical bars */
  .bar{position:relative;width:52px;height:260px;border-radius:26px;background:linear-gradient(180deg,#0f1722,#0c121b);border:1px solid #1e2a3a;box-shadow:inset 0 2px 10px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.04)}
  .bar .fill{position:absolute;left:3px;right:3px;bottom:3px;border-radius:22px;background:linear-gradient(180deg,#e9f2fb,#cfd9e6);box-shadow:0 6px 18px rgba(0,0,0,.35), inset 0 -6px 10px rgba(0,0,0,.12)}
  .bar.temp{background:linear-gradient(180deg,#0f1722,#0c121b);}
  .bar.temp::before{content:"";position:absolute;left:19px;right:19px;top:3px;bottom:3px;border-radius:22px;background:linear-gradient(to top,#ffb169 0%,#ffd9ad 35%,#fffaf1 55%,#e9f4ff 80%,#cfe8ff 100%);filter:saturate(1.2);opacity:.9}
  .bar.temp .fill{background:linear-gradient(180deg,rgba(240,245,255,.95),rgba(220,230,245,.95))}
  .bar.grab{filter:brightness(1.05)}
  .bottom{position:sticky;bottom:0;padding:14px 20px;background:linear-gradient(180deg,transparent 0%,rgba(11,15,20,.85) 40%,rgba(11,15,20,.98) 100%);display:grid;place-items:center;border-top:1px solid #0f1722}
  .btn{width:min(420px,92vw);background:linear-gradient(180deg,#25bfae,#15b7a5);color:#061017;font-weight:700;letter-spacing:.2px;padding:14px 18px;border-radius:16px;border:1px solid #0d9488;cursor:pointer;box-shadow:0 10px 25px rgba(20,170,150,.35), inset 0 1px 0 rgba(255,255,255,.4);transition:transform .04s ease-in-out, filter .15s ease}
  .btn:active{transform:translateY(1px)} .btn.off{background:linear-gradient(180deg,#334155,#283445);color:#cbd5e1;border-color:#1f2937;box-shadow:none} .muted{opacity:.5;filter:grayscale(.15)}
</style>
</head>
<body>
<div class="wrap">
  <div class="grid">
    <div class="card">
      <h1>Настольная лампа</h1>
      <div class="sub">Мини-панель управления</div>
      <div class="sliders">
        <div class="vslider" id="briBox">
          <div class="label">Яркость</div>
          <div id="briBar" class="bar"><div class="fill" style="height:50%"></div></div>
          <div class="value" id="briVal">50%</div>
        </div>
        <div class="vslider" id="tmpBox">
          <div class="label">Температура</div>
          <div id="tmpBar" class="bar temp"><div class="fill" style="height:50%"></div></div>
          <div class="value" id="tmpVal">4000K</div>
        </div>
      </div>
    </div>
  </div>
  <div class="bottom"><button id="power" class="btn">Включить</button></div>
</div>
<script>
const $ = s => document.querySelector(s);
const briBar = $('#briBar'), tmpBar = $('#tmpBar'), power = $('#power');
const briFill = () => $('#briBar .fill');
const tmpFill = () => $('#tmpBar .fill');
const briVal = $('#briVal'), tmpVal = $('#tmpVal');
let state = { on:true, brightness:50, temperature_k:4000 }, t1=null, t2=null, sending=false, dragging=null;

init();
async function init(){
  try{ const r = await fetch('/api/state'); const j = await r.json(); if(j.ok){ state=j; applyUI(); } }catch{}
  setupBar(briBar, 1, 100, v => { briVal.textContent=v+'%'; debounce('b',()=>send({brightness:v})); });
  setupBar(tmpBar, 2700, 6500, v => { tmpVal.textContent=v+'K'; debounce('t',()=>send({temperature_k:v})); });
  power.addEventListener('click', async () => { const on=!state.on; await send({on}); state.on=on; applyUI(); });
}
function applyUI(){
  const briPct = (state.brightness-1)/(100-1);
  const tmpPct = (state.temperature_k-2700)/(6500-2700);
  briFill().style.height = Math.round(briPct*100)+'%';
  tmpFill().style.height = Math.round(tmpPct*100)+'%';
  briVal.textContent=state.brightness+'%';
  tmpVal.textContent=state.temperature_k+'K';
  power.textContent=state.on?'Выключить':'Включить';
  power.classList.toggle('off',!state.on);
  document.querySelector('.card').classList.toggle('muted',!state.on);
}
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
function debounce(which,fn){ if(which==='b'){ clearTimeout(t1); t1=setTimeout(fn,120);} else { clearTimeout(t2); t2=setTimeout(fn,120);} }
async function send(patch){ if(sending) return; sending=true; try{ const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)}); const j=await r.json(); if(!j.ok) console.warn('action failed', j); else Object.assign(state,patch);}catch(e){console.error(e);} sending=false;}

// Pointer handling for bars
function setupBar(el, min, max, onChange){
  const getValueFromY = (clientY) => {
    const rect = el.getBoundingClientRect();
    const y = clamp(clientY - rect.top, 0, rect.height);
    const pct = 1 - (y / rect.height);
    const value = Math.round(min + pct * (max - min));
    return clamp(value, min, max);
  };
  const updateFill = (val) => {
    const pct = (val - min) / (max - min);
    el.querySelector('.fill').style.height = Math.round(pct*100) + '%';
  };
  const start = (ev) => {
    ev.preventDefault(); el.classList.add('grab'); dragging = el;
    const cY = ev.touches? ev.touches[0].clientY : ev.clientY;
    const v = getValueFromY(cY); updateFill(v); onChange(v);
    window.addEventListener('pointermove', move, { passive:false });
    window.addEventListener('pointerup', end, { passive:false, once:true });
    window.addEventListener('touchmove', move, { passive:false });
    window.addEventListener('touchend', end, { passive:false, once:true });
    window.addEventListener('mousemove', move, { passive:false });
    window.addEventListener('mouseup', end, { passive:false, once:true });
  };
  const move = (ev) => {
    if(dragging!==el) return;
    ev.preventDefault();
    const cY = ev.touches? ev.touches[0].clientY : (ev.clientY ?? 0);
    const v = getValueFromY(cY); updateFill(v); onChange(v);
  };
  const end = () => { el.classList.remove('grab'); dragging=null; cleanup(); };
  const cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('touchmove', move);
    window.removeEventListener('touchend', end);
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', end);
  };
  el.addEventListener('pointerdown', start);
  el.addEventListener('touchstart', start, { passive:false });
  el.addEventListener('mousedown', start);
}
</script>
</body></html>`;