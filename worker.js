const CORS = {
  "Access-Control-Allow-Origin": "https://blackitking.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Import-Key"
};

function res(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, ...headers }
  });
}

function json(data, status = 200) {
  return res(JSON.stringify(data), status, {
    "Content-Type": "application/json"
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return res(null, 204);

    if (url.pathname === "/") {
      return new Response("Data Zanyari Worker is running.");
    }

    if (url.pathname === "/api/import" && request.method === "POST") {
      return importData(request, env);
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        await telegram(update, env);
        return new Response("OK");
      } catch (e) {
        console.error(e);
        return new Response("ERROR", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};


/* =========================
   IMPORT DATA
========================= */

async function importData(request, env) {
  try {
    const key = request.headers.get("X-Import-Key");

    if (!env.IMPORT_KEY || key !== env.IMPORT_KEY) {
      return res("Unauthorized", 401);
    }

    const body = await request.json();
    const people = body.people;

    if (!Array.isArray(people)) {
      return json({ ok: false, error: "people must be an array" }, 400);
    }

    for (let i = 0; i < people.length; i += 50) {
      const chunk = people.slice(i, i + 50);

      const statements = chunk.map(p => {
        const id = String(p.id || crypto.randomUUID());
        const name = String(p.name || "");
        const phone = String(p.phone || "");
        const more = String(p.more || "");

        return env.DB.prepare(`
          INSERT OR REPLACE INTO people
          (id, name, phone, more)
          VALUES (?, ?, ?, ?)
        `).bind(id, name, phone, more);
      });

      await env.DB.batch(statements);
    }

    return json({
      ok: true,
      imported: people.length
    });

  } catch (e) {
    console.error("IMPORT ERROR:", e);
    return json({
      ok: false,
      error: String(e)
    }, 500);
  }
}


/* =========================
   TELEGRAM
========================= */

async function telegram(update, env) {

  if (update.callback_query) {
    await callback(update.callback_query, env);
    return;
  }

  const message = update.message;

  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (String(chatId) !== String(env.ADMIN_ID)) {
    await send(
      env,
      chatId,
      "ببورە، ئەم بۆتە تەنها بۆ بەکارهێنانی ڕێگەپێدراوە."
    );
    return;
  }

  if (text === "/start") {
    await setMode(env, chatId, "menu");
    await menu(env, chatId);
    return;
  }

  if (text === "/count") {
    const r = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM people")
      .first();

    await send(
      env,
      chatId,
      `📊 کۆی داتا: ${r?.count || 0}`
    );

    return;
  }

  const mode = await getMode(env, chatId);

  if (mode === "name") {
    await searchName(env, chatId, text);
    return;
  }

  if (mode === "phone") {
    await searchPhone(env, chatId, text);
    return;
  }

  await menu(env, chatId);
}


/* =========================
   BUTTONS
========================= */

async function callback(query, env) {

  const chatId = query.message?.chat?.id;

  if (!chatId) return;

  if (String(chatId) !== String(env.ADMIN_ID)) {
    await answer(env, query.id, "ڕێگەپێدراو نییت.");
    return;
  }

  const data = query.data || "";

  if (data === "name") {

    await setMode(env, chatId, "name");

    await answer(env, query.id);

    await send(
      env,
      chatId,
      "👤 تکایە ناوی کەسەکە بنووسە:"
    );

    return;
  }

  if (data === "phone") {

    await setMode(env, chatId, "phone");

    await answer(env, query.id);

    await send(
      env,
      chatId,
      "📱 تکایە ژمارەی تەلەفون بنووسە:"
    );

    return;
  }

  if (data === "menu") {

    await setMode(env, chatId, "menu");

    await answer(env, query.id);

    await menu(env, chatId);

    return;
  }

  if (data.startsWith("person:")) {

    await answer(env, query.id);

    const id = data.substring(7);

    await showPerson(env, chatId, id);
  }
}


/* =========================
   MAIN MENU
========================= */

async function menu(env, chatId) {

  await keyboard(
    env,
    chatId,

    "بەخێربێیت 👋\n\nتکایە دانەیەکیان هەڵبژێرە:",

    [
      [
        {
          text: "👤 گەڕان بە ناو",
          callback_data: "name"
        }
      ],
      [
        {
          text: "📱 ژمارەی تەلەفون",
          callback_data: "phone"
        }
      ]
    ]
  );
}


/* =========================
   NAME SEARCH
========================= */

async function searchName(env, chatId, text) {

  const words = normalize(text)
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) {
    await send(
      env,
      chatId,
      "👤 تکایە ناوێک بنووسە."
    );
    return;
  }

  const people = await getPeople(env);

  const results = people.filter(person => {

    const nameWords = normalize(person.name)
      .split(/\s+/)
      .filter(Boolean);

    return words.every(searchWord =>
      nameWords.some(nameWord =>
        nameWord.startsWith(searchWord)
      )
    );

  }).slice(0, 50);


  if (!results.length) {

    await send(
      env,
      chatId,
      "❌ هیچ کەسێک بەو ناوە نەدۆزرایەوە."
    );

    return;
  }


  const buttons = results.map(person => {

    const birth = getBirth(person);

    const title = birth
      ? `👤 ${person.name} — 📅 ${birth}`
      : `👤 ${person.name}`;

    return [{
      text: title.slice(0, 60),
      callback_data: `person:${person.id}`
    }];

  });


  buttons.push([
    {
      text: "⬅️ گەڕانەوە",
      callback_data: "menu"
    }
  ]);


  await keyboard(
    env,
    chatId,

    `🔎 ${results.length} ئەنجام دۆزرایەوە.\n\nیەکێکیان هەڵبژێرە:`,

    buttons
  );
}


/* =========================
   PHONE SEARCH
========================= */

async function searchPhone(env, chatId, text) {

  const phone = normalizePhone(text);

  if (!phone) {

    await send(
      env,
      chatId,
      "📱 تکایە ژمارەی تەلەفون بنووسە."
    );

    return;
  }


  const people = await getPeople(env);

  const results = people.filter(person =>
    normalizePhone(person.phone).includes(phone)
  ).slice(0, 50);


  if (!results.length) {

    await send(
      env,
      chatId,
      "❌ هیچ کەسێک بەو ژمارەیە نەدۆزرایەوە."
    );

    return;
  }


  const buttons = results.map(person => {

    const birth = getBirth(person);

    const title = birth
      ? `👤 ${person.name} — 📅 ${birth}`
      : `👤 ${person.name}`;

    return [{
      text: title.slice(0, 60),
      callback_data: `person:${person.id}`
    }];

  });


  buttons.push([
    {
      text: "⬅️ گەڕانەوە",
      callback_data: "menu"
    }
  ]);


  await keyboard(
    env,
    chatId,

    `📱 ${results.length} ئەنجام دۆزرایەوە.\n\nیەکێکیان هەڵبژێرە:`,

    buttons
  );
}


/* =========================
   SHOW PERSON
========================= */

async function showPerson(env, chatId, id) {

  const person = await env.DB
    .prepare(`
      SELECT id, name, phone, more
      FROM people
      WHERE id = ?
      LIMIT 1
    `)
    .bind(id)
    .first();


  if (!person) {

    await send(
      env,
      chatId,
      "❌ داتا نەدۆزرایەوە."
    );

    return;
  }


  const birth = getBirth(person);

  let text =
    `👤 ناو: ${person.name || "-"}\n` +
    `📅 موالید: ${birth || "لە داتا نییە"}\n` +
    `📱 تەلەفون: ${person.phone || "-"}`;


  if (person.more) {
    text += `\n📝 زانیاری زیاتر: ${person.more}`;
  }


  await keyboard(
    env,
    chatId,
    text,
    [
      [
        {
          text: "⬅️ گەڕانەوە بۆ سەرەتا",
          callback_data: "menu"
        }
      ]
    ]
  );
}


/* =========================
   GET DATA
========================= */

async function getPeople(env) {

  const result = await env.DB
    .prepare(`
      SELECT id, name, phone, more
      FROM people
      LIMIT 10000
    `)
    .all();

  return result.results || [];
}


/* =========================
   BIRTH
========================= */

function getBirth(person) {

  const more = String(person.more || "");

  const labeled = more.match(
    /(?:موالید|موڵید|میلاد|لەدایکبوون|birth|ساڵ)[^\d]{0,15}((?:19|20)\d{2})/i
  );

  if (labeled) {
    return labeled[1];
  }


  const year = more.match(
    /\b((?:19|20)\d{2})\b/
  );

  return year ? year[1] : "";
}


/* =========================
   TELEGRAM API
========================= */

async function send(env, chatId, text) {

  return fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4000)
      })
    }
  );
}


async function keyboard(
  env,
  chatId,
  text,
  buttons
) {

  return fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4000),
        reply_markup: {
          inline_keyboard: buttons
        }
      })
    }
  );
}


async function answer(env, id, text = "") {

  return fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        callback_query_id: id,
        text,
        show_alert: false
      })
    }
  );
}


/* =========================
   MODE
========================= */

async function setMode(env, chatId, mode) {

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL
    )
  `).run();


  await env.DB.prepare(`
    INSERT OR REPLACE INTO bot_sessions
    (chat_id, mode)
    VALUES (?, ?)
  `)
  .bind(String(chatId), mode)
  .run();
}


async function getMode(env, chatId) {

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL
    )
  `).run();


  const row = await env.DB
    .prepare(`
      SELECT mode
      FROM bot_sessions
      WHERE chat_id = ?
    `)
    .bind(String(chatId))
    .first();


  return row?.mode || "menu";
}


/* =========================
   NORMALIZE
========================= */

function normalize(value) {

  return String(value || "")
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/[ۀة]/g, "ە")
    .replace(/[ؤ]/g, "ۆ")
    .replace(/\s+/g, " ")
    .trim();
}


function normalizePhone(value) {

  return String(value || "")
    .replace(/[^\d+]/g, "");
}
