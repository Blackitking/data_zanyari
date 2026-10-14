const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://blackitking.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Import-Key",
  "Access-Control-Max-Age": "86400"
};

const WORKER_VERSION = "2026-10-14-DATA-ZANYARI-V12";
const SEARCH_BATCH_SIZE = 1000;
const MAX_SEARCH_ROWS = 50000;

function response(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, ...headers }
  });
}

function json(data, status = 200) {
  return response(JSON.stringify(data), status, {
    "Content-Type": "application/json; charset=utf-8"
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return response(null, 204);
    }

    if (url.pathname === "/api/search/name" && request.method === "GET") {
      return searchNameAPI(request, env);
    }

    if (url.pathname === "/api/search/phone" && request.method === "GET") {
      return searchPhoneAPI(request, env);
    }

    if (url.pathname === "/api/import" && request.method === "POST") {
      return importPeople(request, env);
    }

    if (url.pathname === "/api/deduplicate" && request.method === "POST") {
      return deduplicateAPI(request, env);
    }

    if (url.pathname === "/api/telegram/export" && request.method === "POST") {
      return telegramExport(request, env);
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      try {
        await handleTelegram(await request.json(), env);
        return response("OK");
      } catch (error) {
        console.error("TELEGRAM ERROR:", error);
        return response("ERROR", 500);
      }
    }

    if (url.pathname === "/") {
      return response(
        `Data Zanyari Worker is running.\nVersion: ${WORKER_VERSION}`
      );
    }

    return json({
      ok: false,
      error: "Not Found"
    }, 404);
  }
};

/* =========================
   SEARCH BY NAME
========================= */

async function searchNameAPI(request, env) {
  try {
    const query = normalizeName(
      new URL(request.url).searchParams.get("q") || ""
    );

    if (!query) {
      return json({
        ok: true,
        people: [],
        count: 0
      });
    }

    const people = await getAllPeopleForSearch(env);

    const matched = people.filter(person =>
      exactNamePhraseMatch(person.name, query)
    );

    const results = deduplicateExactRecords(matched).slice(0, 50);

    return json({
      ok: true,
      people: results,
      count: results.length
    });
  } catch (error) {
    console.error("NAME API ERROR:", error);

    return json({
      ok: false,
      error: String(error)
    }, 500);
  }
}

/* =========================
   SEARCH BY PHONE
========================= */

async function searchPhoneAPI(request, env) {
  try {
    const phone = normalizePhone(
      new URL(request.url).searchParams.get("q") || ""
    );

    if (!phone) {
      return json({
        ok: true,
        people: [],
        count: 0
      });
    }

    const people = await getAllPeopleForSearch(env);

    const matched = people.filter(person =>
      normalizePhone(person.phone).includes(phone)
    );

    const results = deduplicateExactRecords(matched).slice(0, 50);

    return json({
      ok: true,
      people: results,
      count: results.length
    });
  } catch (error) {
    console.error("PHONE API ERROR:", error);

    return json({
      ok: false,
      error: String(error)
    }, 500);
  }
}

/* =========================
   GET DATABASE RECORDS
========================= */

async function getAllPeopleForSearch(env) {
  const all = [];

  for (
    let offset = 0;
    offset < MAX_SEARCH_ROWS;
    offset += SEARCH_BATCH_SIZE
  ) {
    const result = await env.DB.prepare(`
      SELECT id, name, phone, more
      FROM people
      ORDER BY rowid ASC
      LIMIT ? OFFSET ?
    `).bind(SEARCH_BATCH_SIZE, offset).all();

    const rows = result.results || [];

    all.push(...rows);

    if (rows.length < SEARCH_BATCH_SIZE) {
      break;
    }
  }

  return all;
}

/* =========================
   IMPORT PEOPLE
========================= */

async function importPeople(request, env) {
  try {
    const key = request.headers.get("X-Import-Key");

    if (!env.IMPORT_KEY || key !== env.IMPORT_KEY) {
      return response("Unauthorized", 401);
    }

    const body = await request.json();

    if (!Array.isArray(body.people)) {
      return json({
        ok: false,
        error: "people must be an array"
      }, 400);
    }

    const people = body.people.map(person => ({
      id: String(person.id || crypto.randomUUID()),
      name: String(person.name || ""),
      phone: String(person.phone || ""),
      more: String(person.more || "")
    }));

    let imported = 0;

    for (let i = 0; i < people.length; i += 50) {
      const chunk = people.slice(i, i + 50);

      const statements = chunk.map(person =>
        env.DB.prepare(`
          INSERT OR REPLACE INTO people
          (id, name, phone, more)
          VALUES (?, ?, ?, ?)
        `).bind(
          person.id,
          person.name,
          person.phone,
          person.more
        )
      );

      if (statements.length) {
        await env.DB.batch(statements);
        imported += statements.length;
      }
    }

    return json({
      ok: true,
      imported,
      duplicatesRemoved: 0
    });
  } catch (error) {
    console.error("IMPORT ERROR:", error);

    return json({
      ok: false,
      error: String(error)
    }, 500);
  }
}

/* =========================
   MANUAL DEDUPLICATION
========================= */

async function deduplicateAPI(request, env) {
  try {
    const key = request.headers.get("X-Import-Key");

    if (!env.IMPORT_KEY || key !== env.IMPORT_KEY) {
      return response("Unauthorized", 401);
    }

    const result = await deduplicateDatabase(env);

    return json({
      ok: true,
      message: "پاککردنەوە تەواو بوو.",
      duplicatesRemoved: result.deleted,
      remaining: result.remaining
    });
  } catch (error) {
    console.error("DEDUPLICATE ERROR:", error);

    return json({
      ok: false,
      error: String(error)
    }, 500);
  }
}

async function deduplicateDatabase(env) {
  const result = await env.DB.prepare(`
    SELECT id, name
    FROM people
    WHERE name IS NOT NULL
    ORDER BY rowid ASC
  `).all();

  const seen = new Set();
  const duplicateIds = [];

  for (const person of result.results || []) {
    const name = normalizeName(person.name);

    if (!name) {
      continue;
    }

    if (seen.has(name)) {
      duplicateIds.push(String(person.id));
    } else {
      seen.add(name);
    }
  }

  let deleted = 0;

  for (let i = 0; i < duplicateIds.length; i += 40) {
    const statements = duplicateIds
      .slice(i, i + 40)
      .map(id =>
        env.DB.prepare(
          "DELETE FROM people WHERE id = ?"
        ).bind(id)
      );

    if (statements.length) {
      await env.DB.batch(statements);
      deleted += statements.length;
    }
  }

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM people"
  ).first();

  return {
    deleted,
    remaining: Number(count?.count || 0)
  };
}

/* =========================
   EXPORT TO TELEGRAM
========================= */

async function telegramExport(request, env) {
  try {
    if (!env.BOT_TOKEN) {
      return json({
        ok: false,
        error: "BOT_TOKEN is not configured"
      }, 500);
    }

    if (!env.ADMIN_ID) {
      return json({
        ok: false,
        error: "ADMIN_ID is not configured"
      }, 500);
    }

    const body = await request.json();

    if (!Array.isArray(body.people)) {
      return json({
        ok: false,
        error: "people must be an array"
      }, 400);
    }

    if (!body.people.length) {
      return json({
        ok: false,
        error: "No data to export"
      }, 400);
    }

    const people = body.people;

    let text = "گەڕانی ناوەکان - Export\n";
    text += "========================\n\n";
    text += `کۆی تۆمارەکان: ${people.length}\n\n`;

    for (let i = 0; i < people.length; i++) {
      const person = people[i] || {};

      text += "========================\n";
      text += `#${i + 1}\n`;
      text += `ناو: ${person.name || "-"}\n`;
      text += `ژمارەی تەلەفون: ${person.phone || "-"}\n`;
      text += `زانیاری زیاتر: ${person.more || "-"}\n`;

      if (person.id !== undefined && person.id !== null) {
        text += `ID: ${person.id}\n`;
      }

      text += "\n";
    }

    text += "========================\nکۆتایی داتا\n";

    const file = new Blob([text], {
      type: "text/plain; charset=utf-8"
    });

    const form = new FormData();

    form.append("chat_id", String(env.ADMIN_ID));
    form.append(
      "caption",
      `📦 هەموو داتا\n📊 کۆی تۆمارەکان: ${people.length}`
    );
    form.append("document", file, "people-export.txt");

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
      {
        method: "POST",
        body: form
      }
    );

    let telegramResult;

    try {
      telegramResult = await telegramResponse.json();
    } catch {
      telegramResult = {
        ok: false,
        description: "Invalid Telegram response"
      };
    }

    if (!telegramResponse.ok || !telegramResult.ok) {
      console.error("TELEGRAM EXPORT ERROR:", telegramResult);

      return json({
        ok: false,
        error: telegramResult.description || "Telegram API error"
      }, 500);
    }

    return json({
      ok: true,
      exported: people.length,
      duplicatesRemoved: 0,
      type: "txt"
    });
  } catch (error) {
    console.error("TELEGRAM EXPORT ERROR:", error);

    return json({
      ok: false,
      error: String(error)
    }, 500);
  }
}

/* =========================
   TELEGRAM BOT
========================= */

async function handleTelegram(update, env) {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  const message = update.message;

  if (!message || !message.text) {
    return;
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    await setMode(env, chatId, "menu");
    await sendMainMenu(env.BOT_TOKEN, chatId);
    return;
  }

  if (text === "/count") {
    const result = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM people"
    ).first();

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `📊 کۆی داتا: ${result?.count || 0}`
    );

    return;
  }

  if (text === "/cleanup") {
    if (String(chatId) !== String(env.ADMIN_ID)) {
      await sendMessage(
        env.BOT_TOKEN,
        chatId,
        "❌ ئەم فرمانە تەنها بۆ ئەدمینە."
      );
      return;
    }

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "⚠️ ئەم فرمانە ناوە هاوشێوەکان دەسڕێتەوە. ئەگەر کەسانی جیاواز ناویان یەکسانە، بەکاری مەهێنە."
    );

    return;
  }

  if (text === "/version") {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `🔧 وەشانی Worker:\n${WORKER_VERSION}`
    );

    return;
  }

  const mode = await getMode(env, chatId);

  if (mode === "name") {
    await searchByName(env, chatId, text);
    return;
  }

  if (mode === "phone") {
    await searchByPhone(env, chatId, text);
    return;
  }

  if (text) {
    await searchByName(env, chatId, text);
    return;
  }

  await sendMainMenu(env.BOT_TOKEN, chatId);
}

/* =========================
   TELEGRAM BUTTONS
========================= */

async function handleCallback(query, env) {
  const chatId = query.message?.chat?.id;

  if (!chatId) {
    return;
  }

  const data = query.data || "";

  if (data === "search_name") {
    await setMode(env, chatId, "name");
    await answerCallback(env.BOT_TOKEN, query.id);

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "👤 تکایە ناوی کەسەکە بنووسە:"
    );

    return;
  }

  if (data === "search_phone") {
    await setMode(env, chatId, "phone");
    await answerCallback(env.BOT_TOKEN, query.id);

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "📱 تکایە ژمارەی تەلەفون بنووسە:"
    );

    return;
  }

  if (data === "main_menu") {
    await setMode(env, chatId, "menu");
    await answerCallback(env.BOT_TOKEN, query.id);
    await sendMainMenu(env.BOT_TOKEN, chatId);
    return;
  }

  if (data.startsWith("preview:")) {
    await answerCallback(env.BOT_TOKEN, query.id);

    await showPersonPreview(
      env,
      chatId,
      data.slice("preview:".length)
    );
  }
}

/* =========================
   TELEGRAM SEARCH BY NAME
========================= */

async function searchByName(env, chatId, text) {
  const search = normalizeName(text);

  if (!search) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "👤 تکایە ناوێک بنووسە."
    );

    return;
  }

  const people = await getAllPeopleForSearch(env);

  const matched = people.filter(person =>
    exactNamePhraseMatch(person.name, search)
  );

  const results = deduplicateExactRecords(matched).slice(0, 50);

  if (!results.length) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `❌ ببورە، ئەم ناوە نەدۆزرایەوە.\n\n🔎 «${text}»`
    );

    return;
  }

  const buttons = results.map(person => [{
    text: makePersonLabel(person),
    callback_data: `preview:${String(person.id)}`.slice(0, 64)
  }]);

  buttons.push([{
    text: "⬅️ گەڕانەوە",
    callback_data: "main_menu"
  }]);

  await sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `🔎 ${results.length} ئەنجام دۆزرایەوە.`,
    buttons
  );
}

/* =========================
   TELEGRAM SEARCH BY PHONE
========================= */

async function searchByPhone(env, chatId, text) {
  const phone = normalizePhone(text);

  if (!phone) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "📱 تکایە ژمارەی تەلەفون بنووسە."
    );

    return;
  }

  const people = await getAllPeopleForSearch(env);

  const matched = people.filter(person =>
    normalizePhone(person.phone).includes(phone)
  );

  const results = deduplicateExactRecords(matched).slice(0, 50);

  if (!results.length) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ هیچ کەسێک بەو ژمارەیە نەدۆزرایەوە."
    );

    return;
  }

  const buttons = results.map(person => [{
    text: makePersonLabel(person),
    callback_data: `preview:${String(person.id)}`.slice(0, 64)
  }]);

  buttons.push([{
    text: "⬅️ گەڕانەوە",
    callback_data: "main_menu"
  }]);

  await sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `📱 ${results.length} ئەنجام دۆزرایەوە.`,
    buttons
  );
}

/* =========================
   PERSON LABEL
========================= */

function makePersonLabel(person) {
  const name = String(person?.name || "بێ ناو")
    .trim()
    .replace(/\s+/g, " ");

  const age = getAge(person);
  const city = getCity(person);
  const parts = [];

  if (name) parts.push(name);
  if (city) parts.push(city);
  if (age) parts.push(`${age} ساڵ`);

  const label = parts.join(" — ") || "بێ ناو";

  if (label.length <= 64) {
    return label;
  }

  const suffixParts = [];

  if (city) suffixParts.push(city);
  if (age) suffixParts.push(`${age} ساڵ`);

  const suffix = suffixParts.length
    ? ` — ${suffixParts.join(" — ")}`
    : "";

  const available = Math.max(5, 64 - suffix.length - 2);

  return `${name.slice(0, available).trim()}…${suffix}`;
}

/* =========================
   PERSON AGE
========================= */

function getAge(person) {
  const birth = getBirth(person);

  if (!birth) {
    return "";
  }

  const year = Number(birth);
  const currentYear = new Date().getFullYear();

  if (
    !Number.isFinite(year) ||
    year < 1900 ||
    year > currentYear
  ) {
    return "";
  }

  const age = currentYear - year;

  return age >= 0 && age <= 130
    ? String(age)
    : "";
}

/* =========================
   PERSON CITY
========================= */

function getCity(person) {
  let text = String(person?.more || "").trim();

  if (!text) {
    return "";
  }

  text = normalizeDigits(text);

  const patterns = [
    /(?:^|[\n|])\s*(?:شار|شاری)\s*[:：=\-]?\s*([^\n|,،;]+)/iu,
    /(?:^|[\n|])\s*(?:city|city\s*name)\s*[:：=\-]?\s*([^\n|,،;]+)/iu,
    /(?:^|[\n|])\s*(?:مدينة|المحافظة|محافظة)\s*[:：=\-]?\s*([^\n|,،;]+)/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const city = String(match[1])
        .trim()
        .replace(/[.،,;|]+$/g, "")
        .replace(/[👤👥📱📅📝🔎🏙️✅]+$/gu, "")
        .replace(/\s+/g, " ")
        .trim();

      if (city) {
        return city;
      }
    }
  }

  return "";
}

/* =========================
   PERSON DETAILS
========================= */

async function showPersonPreview(env, chatId, id) {
  const person = await getPerson(env, id);

  if (!person) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ داتا نەدۆزرایەوە."
    );

    return;
  }

  const name = String(person.name || "").trim();
  const phone = String(person.phone || "").trim();
  const more = String(person.more || "").trim();

  let text = `👤 ناو: ${name || "نییە"}\n\n`;
  text += `📱 ژمارەی تەلەفون: ${phone || "نییە"}\n\n`;
  text += "📋 هەموو زانیارییەکان:\n";
  text += more || "هیچ زانیارییەکی زیادە نییە.";

  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    text
  );
}

async function getPerson(env, id) {
  const cleanId = String(id || "").trim();

  if (!cleanId) {
    return null;
  }

  return await env.DB.prepare(`
    SELECT id, name, phone, more
    FROM people
    WHERE id = ?
    LIMIT 1
  `).bind(cleanId).first();
}

/* =========================
   REMOVE EXACT DUPLICATES
========================= */

function deduplicateExactRecords(people) {
  const seen = new Set();
  const result = [];

  for (const person of people || []) {
    const key = person?.id != null
      ? String(person.id)
      : `${normalizeName(person?.name)}|${normalizePhone(person?.phone)}|${String(person?.more || "").trim()}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(person);
  }

  return result;
}

/* =========================
   NORMALIZE DIGITS
========================= */

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[٠-٩]/g, digit =>
      String(digit.charCodeAt(0) - 0x0660)
    )
    .replace(/[۰-۹]/g, digit =>
      String(digit.charCodeAt(0) - 0x06F0)
    );
}

/* =========================
   GET BIRTH YEAR
========================= */

function getBirth(person) {
  const original = String(person?.more || "");

  if (!original.trim()) {
    return "";
  }

  const more = normalizeDigits(original);

  const labeled = more.match(
    /(?:موالید|موڵید|میلاد|لەدایکبوون|لەدایک‌بوون|ساڵی\s*لەدایکبوون|ساڵی\s*لە\s*دایک\s*بوون|birth|year\s*of\s*birth)[^\d]{0,50}((?:18|19|20)\d{2})/i
  );

  if (labeled) {
    return labeled[1];
  }

  const year = more.match(
    /(?:^|[^\d])((?:18|19|20)\d{2})(?:$|[^\d])/m
  );

  return year ? year[1] : "";
}

/* =========================
   TELEGRAM MAIN MENU
========================= */

async function sendMainMenu(token, chatId) {
  await sendMessageWithKeyboard(
    token,
    chatId,
    "بەخێربێیت 👋\n\nتکایە دانەیەکیان هەڵبژێرە:",
    [
      [{
        text: "👤 گەڕان بە ناو",
        callback_data: "search_name"
      }],
      [{
        text: "📱 ژمارەی تەلەفون",
        callback_data: "search_phone"
      }]
    ]
  );
}

/* =========================
   TELEGRAM SEND MESSAGE
========================= */

async function sendMessage(token, chatId, text) {
  return fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
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

/* =========================
   TELEGRAM SEND KEYBOARD
========================= */

async function sendMessageWithKeyboard(
  token,
  chatId,
  text,
  keyboard
) {
  return fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4000),
        reply_markup: {
          inline_keyboard: keyboard
        }
      })
    }
  );
}

/* =========================
   ANSWER CALLBACK
========================= */

async function answerCallback(
  token,
  callbackId,
  text = ""
) {
  return fetch(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text,
        show_alert: false
      })
    }
  );
}

/* =========================
   TELEGRAM SESSION MODE
========================= */

async function setMode(env, chatId, mode) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'menu'
    )
  `).run();

  await env.DB.prepare(`
    INSERT OR REPLACE INTO bot_sessions
    (chat_id, mode)
    VALUES (?, ?)
  `).bind(
    String(chatId),
    mode
  ).run();
}

async function getMode(env, chatId) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'menu'
    )
  `).run();

  const row = await env.DB.prepare(`
    SELECT mode
    FROM bot_sessions
    WHERE chat_id = ?
  `).bind(
    String(chatId)
  ).first();

  return row?.mode || "menu";
}

/* =========================
   NORMALIZE NAME
========================= */

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[يىئ]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ۀة]/g, "ە")
    .replace(/ؤ/g, "ۆ")
    .replace(/[أإآ]/g, "ا")
    .replace(/[،,؛;|/\\()[\]{}:_"'`.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   EXACT NAME PHRASE MATCH
========================= */

function exactNamePhraseMatch(name, search) {
  const fullName = normalizeName(name);
  const query = normalizeName(search);

  if (!fullName || !query) {
    return false;
  }

  if (fullName === query) {
    return true;
  }

  const nameWords = fullName.split(/\s+/).filter(Boolean);
  const queryWords = query.split(/\s+/).filter(Boolean);

  if (
    !nameWords.length ||
    !queryWords.length ||
    queryWords.length > nameWords.length
  ) {
    return false;
  }

  for (
    let start = 0;
    start <= nameWords.length - queryWords.length;
    start++
  ) {
    let match = true;

    for (let i = 0; i < queryWords.length; i++) {
      if (nameWords[start + i] !== queryWords[i]) {
        match = false;
        break;
      }
    }

    if (match) {
      return true;
    }
  }

  return false;
}

/* =========================
   NORMALIZE PHONE
========================= */

function normalizePhone(value) {
  return normalizeDigits(value).replace(/[^\d+]/g, "");
}
