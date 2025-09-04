export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // healthcheck + проверка токена Яндекса
    if (url.pathname === "/selftest") {
      const r = await fetch("https://api.iot.yandex.net/v1.0/user/info", {
        headers: { "Authorization": `Bearer ${env.YANDEX_TOKEN}` }
      });
      console.log("selftest yandex status", r.status);
      return new Response(JSON.stringify({ yandex_status: r.status }), {
        headers: { "content-type": "application/json" }
      });
    }

    if (url.pathname === "/") return new Response("ok");
    if (url.pathname !== "/tg" || request.method !== "POST")
      return new Response("not found", { status: 404 });

    // 1) проверка секрета
    const hdrSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    console.log("hdrSecret present?", !!hdrSecret);
    if (hdrSecret !== env.TG_SECRET) {
      console.log("secret mismatch");
      return new Response("forbidden", { status: 403 });
    }

    // 2) парсим апдейт
    let update;
    try { update = await request.json(); }
    catch (e) {
      console.log("json parse error", e);
      return new Response("bad json", { status: 400 });
    }
    const msg = update?.message;
    const text = msg?.text?.trim() || "";
    const chatId = msg?.chat?.id;
    console.log("incoming", { chatId, text });

    // 3) ограничение по chat_id (если задано)
    if (env.ALLOWED_CHAT_ID && String(chatId) !== String(env.ALLOWED_CHAT_ID)) {
      await sendTG(env, chatId, "🚫 Не авторизован.");
      return new Response("ok");
    }

    const [cmd, arg1] = text.split(/\s+/, 2);
    let actions = null;
    let reply = "Команды: /on /off /bri 1-100 /temp 2700-6500 /scene night|reading";

    if (cmd === "/on") {
      actions = [{ type: "devices.capabilities.on_off", state: { instance: "on", value: true } }];
      reply = "✅ Включаю";
    } else if (cmd === "/off") {
      actions = [{ type: "devices.capabilities.on_off", state: { instance: "on", value: false } }];
      reply = "✅ Выключаю";
    } else if (cmd === "/bri") {
      const v = Math.max(1, Math.min(100, parseInt(arg1 || "0", 10)));
      if (Number.isFinite(v)) {
        actions = [{ type: "devices.capabilities.range", state: { instance: "brightness", value: v } }];
        reply = `🔆 Яркость ${v}%`;
      } else reply = "Использование: /bri 1-100";
    } else if (cmd === "/temp") {
      const v = Math.max(2700, Math.min(6500, parseInt(arg1 || "0", 10)));
      if (Number.isFinite(v)) {
        actions = [{ type: "devices.capabilities.color_setting", state: { instance: "temperature_k", value: v } }];
        reply = `🌡️ Теплота ${v}K`;
      } else reply = "Использование: /temp 2700-6500";
    } else if (cmd === "/scene") {
      const scene = (arg1 || "").toLowerCase();
      if (["night","reading"].includes(scene)) {
        actions = [{ type: "devices.capabilities.color_setting", state: { instance: "scene", value: scene } }];
        reply = `🎨 Сцена: ${scene}`;
      } else reply = "Доступные: night, reading";
    }

    if (actions) {
      const ok = await yaAction(env, actions);
      console.log("yandex action ok?", ok);
      if (!ok) reply = "❌ Ошибка при обращении к Yandex IoT";
    }

    const okSend = await sendTG(env, chatId, reply);
    console.log("tg send status ok?", okSend);
    return new Response("ok");
  }
};

async function yaAction(env, actions) {
  const body = { devices: [{ id: env.YANDEX_DEVICE_ID, actions }] };
  const r = await fetch("https://api.iot.yandex.net/v1.0/devices/actions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.YANDEX_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  console.log("yandex resp", r.status, txt.slice(0, 200));
  return r.ok;
}

async function sendTG(env, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const t = await r.text();
  console.log("tg send resp", r.status, t.slice(0, 200));
  return r.ok;
}
