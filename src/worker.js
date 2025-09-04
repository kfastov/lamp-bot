export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // healthcheck
    if (url.pathname === "/") return new Response("ok");

    // Telegram webhook endpoint
    if (url.pathname !== "/tg" || request.method !== "POST")
      return new Response("not found", { status: 404 });

    // проверяем секрет
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.TG_SECRET) return new Response("forbidden", { status: 403 });

    const update = await request.json();
    const msg = update.message;
    if (!msg || !msg.text) return new Response("ok");

    const chatId = msg.chat?.id;
    if (env.ALLOWED_CHAT_ID && String(chatId) !== String(env.ALLOWED_CHAT_ID)) {
      await sendTG(env, chatId, "🚫 Не авторизован.");
      return new Response("ok");
    }

    const text = msg.text.trim();
    const [cmd, arg1] = text.split(/\s+/, 2);
    let actions = null;
    let reply = "Команды: /on /off /bri 0-100 /temp 2700-6500 /scene night|reading";

    if (cmd === "/on") {
      actions = [{
        type: "devices.capabilities.on_off",
        state: { instance: "on", value: true }
      }];
      reply = "✅ Включаю";
    } else if (cmd === "/off") {
      actions = [{
        type: "devices.capabilities.on_off",
        state: { instance: "on", value: false }
      }];
      reply = "✅ Выключаю";
    } else if (cmd === "/bri") {
      const v = Math.max(1, Math.min(100, parseInt(arg1 || "0", 10)));
      if (isFinite(v)) {
        actions = [{
          type: "devices.capabilities.range",
          state: { instance: "brightness", value: v }
        }];
        reply = `🔆 Яркость ${v}%`;
      } else reply = "Использование: /bri 0-100";
    } else if (cmd === "/temp") {
      const v = Math.max(2700, Math.min(6500, parseInt(arg1 || "0", 10)));
      if (isFinite(v)) {
        actions = [{
          type: "devices.capabilities.color_setting",
          state: { instance: "temperature_k", value: v }
        }];
        reply = `🌡️ Теплота ${v}K`;
      } else reply = "Использование: /temp 2700-6500";
    } else if (cmd === "/scene") {
      const scene = (arg1 || "").toLowerCase();
      if (["night","reading"].includes(scene)) {
        actions = [{
          type: "devices.capabilities.color_setting",
          state: { instance: "scene", value: scene }
        }];
        reply = `🎨 Сцена: ${scene}`;
      } else reply = "Доступные: night, reading";
    }

    if (actions) {
      const ok = await yaAction(env, actions);
      if (!ok) reply = "❌ Ошибка при обращении к Яндекс IoT";
    }

    await sendTG(env, chatId, reply);
    return new Response("ok");
  }
};

async function yaAction(env, actions) {
  const body = {
    devices: [{
      id: env.YANDEX_DEVICE_ID,
      actions
    }]
  };
  const r = await fetch("https://api.iot.yandex.net/v1.0/devices/actions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.YANDEX_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return r.ok;
}

async function sendTG(env, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return r.ok;
}
