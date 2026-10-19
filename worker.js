const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://blackitking.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Import-Key",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const WORKER_VERSION = "2026-10-19-DATA-ZANYARI-V14-ELECTRICITY";
const SEARCH_BATCH_SIZE = 1000;
const MAX_SEARCH_ROWS = 50000;
const MAX_RESULTS = 50;

/* RESPONSE HELPERS */

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

/* MAIN WORKER */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return response(null, 204);
    }

    try {
      if (!env.DB) {
        throw new Error("D1 binding DB is missing");
      }

      /*
       * Add electricity column when missing.
       * Existing people records are preserved.
       */
      if (url.pathname !== "/" || request.method !== "GET") {
        await ensurePeopleSchema(env);
      }

      if (url.pathname === "/" && request.method === "GET") {
        return response(
          `Data Zanyari Worker is running.\nVersion: ${WORKER_VERSION}`
        );
      }

      if (
        url.pathname === "/api/search/name" &&
        request.method === "GET"
      ) {
        return await searchNameAPI(request, env);
      }

      if (
        url.pathname === "/api/search/phone" &&
        request.method === "GET"
      ) {
        return await searchPhoneAPI(request, env);
      }

      if (
        url.pathname === "/api/search/electricity" &&
        request.method === "GET"
      ) {
        return await searchElectricityAPI(request, env);
      }

      if (
        url.pathname === "/api/import" &&
        request.method === "POST"
      ) {
        return await importPeople(request, env);
      }

      if (
        url.pathname === "/api/deduplicate" &&
        request.method === "POST"
      ) {
        return await deduplicateAPI(request, env);
      }

      if (
        url.pathname === "/api/telegram/export" &&
        request.method === "POST"
      ) {
        return await telegramExport(request, env);
      }

      if (
        url.pathname === "/telegram/webhook" &&
        request.method === "POST"
      ) {
        await handleTelegram(await request.json(), env);
        return response("OK");
      }

      return json({ ok: false, error: "Not Found" }, 404);

    } catch (error) {
      console.error("WORKER ERROR:", error);

      return json({
        ok: false,
        error: "Internal server error"
      }, 500);
    }
  }
};

/* DATABASE SCHEMA */

async function ensurePeopleSchema(env) {
  const columns = await env.DB
    .prepare("PRAGMA table_info(people)")
    .all();

  const rows = columns.results || [];

  if (!rows.length) {
    throw new Error(
      "Table people does not exist. Existing database was not modified."
    );
  }

  const hasElectricity = rows.some(
    column => column.name === "electricity"
  );

  if (!hasElectricity) {
    await env.DB.prepare(
      "ALTER TABLE people ADD COLUMN electricity TEXT NOT NULL DEFAULT ''"
    ).run();
  }
}

/* SEARCH BY NAME */

async function searchNameAPI(request, env) {
  try {
    const query = normalizeName(
      new URL(request.url).searchParams.get("q") || ""
    );

    if (!query) {
      return json({ ok: true, people: [], count: 0 });
    }

    const people = await getAllPeopleForSearch(env);

    const results = deduplicateExactRecords(
      people.filter(p => exactNamePhraseMatch(p.name, query))
    ).slice(0, MAX_RESULTS);

    return json({
      ok: true,
      people: results,
      count: results.length
    });

  } catch (error) {
    console.error("NAME SEARCH:", error);

    return json({
      ok: false,
      error: "Name search failed"
    }, 500);
  }
}

/* SEARCH BY PHONE */

async function searchPhoneAPI(request, env) {
  try {
    const query = normalizePhone(
      new URL(request.url).searchParams.get("q") || ""
    );

    if (!query) {
      return json({ ok: true, people: [], count: 0 });
    }

    const people = await getAllPeopleForSearch(env);

    const results = deduplicateExactRecords(
      people.filter(p =>
        normalizePhone(p.phone).includes(query)
      )
    ).slice(0, MAX_RESULTS);

    return json({
      ok: true,
      people: results,
      count: results.length
    });

  } catch (error) {
    console.error("PHONE SEARCH:", error);

    return json({
      ok: false,
      error: "Phone search failed"
    }, 500);
  }
}

/* SEARCH BY ELECTRICITY */

async function searchElectricityAPI(request, env) {
  try {
    const query = normalizeSearchText(
      new URL(request.url).searchParams.get("q") || ""
    );

    if (!query) {
      return json({ ok: true, people: [], count: 0 });
    }

    const people = await getAllPeopleForSearch(env);

    const results = deduplicateExactRecords(
      people.filter(p =>
        normalizeSearchText(p.electricity).includes(query)
      )
    ).slice(0, MAX_RESULTS);

    return json({
      ok: true,
      people: results,
      count: results.length
    });

  } catch (error) {
    console.error("ELECTRICITY SEARCH:", error);

    return json({
      ok: false,
      error: "Electricity search failed"
    }, 500);
  }
}

/* LOAD DATABASE RECORDS */

async function getAllPeopleForSearch(env) {
  const all = [];

  for (
    let offset = 0;
    offset < MAX_SEARCH_ROWS;
    offset += SEARCH_BATCH_SIZE
  ) {
    const result = await env.DB.prepare(
      `SELECT id, name, phone, more, electricity
       FROM people
       ORDER BY rowid ASC
       LIMIT ? OFFSET ?`
    ).bind(SEARCH_BATCH_SIZE, offset).all();

    const rows = result.results || [];

    all.push(...rows);

    if (rows.length < SEARCH_BATCH_SIZE) {
      break;
    }
  }

  return all;
}

/* SAFE IMPORT
 * New IDs are inserted.
 * Existing IDs are not overwritten.
 * Electricity can be updated independently when provided.
 */

async function importPeople(request, env) {
  const key = request.headers.get("X-Import-Key");

  if (!env.IMPORT_KEY || key !== env.IMPORT_KEY) {
    return response("Unauthorized", 401);
  }

  try {
    const body = await request.json();

    if (!Array.isArray(body.people)) {
      return json({
        ok: false,
        error: "people must be an array"
      }, 400);
    }

    let imported = 0;
    let skipped = 0;
    let electricityUpdated = 0;

    for (let i = 0; i < body.people.length; i += 50) {
      const chunk = body.people.slice(i, i + 50);

      for (const p of chunk) {
        const id = String(p?.id || crypto.randomUUID());
        const name = String(p?.name || "");
        const phone = String(p?.phone || "");
        const more = String(p?.more || "");
        const electricity = String(p?.electricity || "");

        const existing = await env.DB.prepare(
          "SELECT id FROM people WHERE id = ? LIMIT 1"
        ).bind(id).first();

        if (existing) {
          skipped++;

          /*
           * Update electricity only.
           * Preserve existing name, phone and more.
           */
          if (electricity.trim()) {
            const update = await env.DB.prepare(
              `UPDATE people
               SET electricity = ?
               WHERE id = ?
                 AND COALESCE(electricity, '') != ?`
            ).bind(electricity, id, electricity).run();

            electricityUpdated += Number(
              update?.meta?.changes || 0
            );
          }

          continue;
        }

        await env.DB.prepare(
          `INSERT INTO people
           (id, name, phone, more, electricity)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          id,
          name,
          phone,
          more,
          electricity
        ).run();

        imported++;
      }
    }

    return json({
      ok: true,
      imported,
      skippedExistingIDs: skipped,
      electricityUpdated,
      duplicatesRemoved: 0
    });

  } catch (error) {
    console.error("IMPORT ERROR:", error);

    return json({
      ok: false,
      error: "Import failed"
    }, 500);
  }
}

/* SAFE DUPLICATE CHECK
 * This endpoint never deletes anything.
 */

async function deduplicateAPI(request, env) {
  const key = request.headers.get("X-Import-Key");

  if (!env.IMPORT_KEY || key !== env.IMPORT_KEY) {
    return response("Unauthorized", 401);
  }

  try {
    const result = await env.DB.prepare(
      `SELECT id, name, phone, more, electricity
       FROM people
       ORDER BY rowid ASC`
    ).all();

    const seen = new Set();
    let repeatedExactRecords = 0;

    for (const p of result.results || []) {
      const key = [
        normalizeName(p.name),
        normalizePhone(p.phone),
        String(p.more || "").trim(),
        normalizeSearchText(p.electricity)
      ].join("|");

      if (seen.has(key)) {
        repeatedExactRecords++;
      } else {
        seen.add(key);
      }
    }

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM people"
    ).first();

    return json({
      ok: true,
      message: "ئەمە تەنها پشکنینە؛ هیچ تۆمارێک نەسڕایەوە.",
      repeatedExactRecords,
      deleted: 0,
      remaining: Number(count?.count || 0)
    });

  } catch (error) {
    console.error("DUPLICATE CHECK:", error);

    return json({
      ok: false,
      error: "Duplicate check failed"
    }, 500);
  }
}

/* TELEGRAM EXPORT */

async function telegramExport(request, env) {
  try {
    if (!env.BOT_TOKEN || !env.ADMIN_ID) {
      return json({
        ok: false,
        error: "BOT_TOKEN or ADMIN_ID is not configured"
      }, 500);
    }

    if (
      !env.IMPORT_KEY ||
      request.headers.get("X-Import-Key") !== env.IMPORT_KEY
    ) {
      return response("Unauthorized", 401);
    }

    const body = await request.json();

    if (!Array.isArray(body.people) || !body.people.length) {
      return json({
        ok: false,
        error: "No data to export"
      }, 400);
    }

    let text =
      `گەڕانی ناوەکان - Export\n` +
      `کۆی تۆمارەکان: ${body.people.length}\n\n`;

    body.people.forEach((p, i) => {
      text +=
        `========================\n` +
        `#${i + 1}\n` +
        `ناو: ${p?.name || "-"}\n` +
        `ژمارەی تەلەفون: ${p?.phone || "-"}\n` +
        `زانیاری زیاتر: ${p?.more || "-"}\n` +
        `کارەبا: ${p?.electricity || "-"}\n`;

      if (p?.id != null) {
        text += `ID: ${p.id}\n`;
      }

      text += "\n";
    });

    const form = new FormData();

    form.append("chat_id", String(env.ADMIN_ID));

    form.append(
      "caption",
      `📦 هەموو داتا | ${body.people.length} تۆمار`
    );

    form.append(
      "document",
      new Blob([text], {
        type: "text/plain;charset=utf-8"
      }),
      "people-export.txt"
    );

    const result = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
      {
        method: "POST",
        body: form
      }
    );

    const data = await result.json().catch(() => ({}));

    if (!result.ok || !data.ok) {
      console.error("TELEGRAM EXPORT:", data);

      return json({
        ok: false,
        error: "Telegram export failed"
      }, 500);
    }

    return json({
      ok: true,
      exported: body.people.length,
      type: "txt"
    });

  } catch (error) {
    console.error("TELEGRAM EXPORT ERROR:", error);

    return json({
      ok: false,
      error: "Export failed"
    }, 500);
  }
}

/* TELEGRAM BOT */

async function handleTelegram(update, env) {
  if (update.callback_query) {
    return handleCallback(update.callback_query, env);
  }

  const message = update.message;

  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    await setMode(env, chatId, "menu");
    return sendMainMenu(env.BOT_TOKEN, chatId);
  }

  if (text === "/count") {
    const result = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM people"
    ).first();

    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      `📊 کۆی داتا: ${result?.count || 0}`
    );
  }

  if (text === "/version") {
    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      `🔧 وەشانی Worker:\n${WORKER_VERSION}`
    );
  }

  if (text === "/cleanup") {
    if (String(chatId) !== String(env.ADMIN_ID)) {
      return sendMessage(
        env.BOT_TOKEN,
        chatId,
        "❌ ئەم فرمانە تەنها بۆ ئەدمینە."
      );
    }

    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      "🛡️ پاککردنەوەی ئۆتۆماتیکی ناچالاکە؛ هیچ تۆمارێک بە خۆکار ناسڕمەوە."
    );
  }

  const mode = await getMode(env, chatId);

  if (mode === "name") {
    return searchByName(env, chatId, text);
  }

  if (mode === "phone") {
    return searchByPhone(env, chatId, text);
  }

  if (mode === "electricity") {
    return searchByElectricity(env, chatId, text);
  }

  return searchByName(env, chatId, text);
}

/* TELEGRAM BUTTON CALLBACKS */

async function handleCallback(query, env) {
  const chatId = query.message?.chat?.id;

  if (!chatId) return;

  const data = query.data || "";

  if (
    data === "search_name" ||
    data === "search_phone" ||
    data === "search_electricity"
  ) {
    let mode;
    let prompt;

    if (data === "search_name") {
      mode = "name";
      prompt = "👤 تکایە ناوی کەسەکە بنووسە:";
    } else if (data === "search_phone") {
      mode = "phone";
      prompt = "📱 تکایە ژمارەی تەلەفون بنووسە:";
    } else {
      mode = "electricity";
      prompt = "⚡ تکایە ژمارە یان زانیاری کارەباکە بنووسە:";
    }

    await setMode(env, chatId, mode);
    await answerCallback(env.BOT_TOKEN, query.id);

    return sendMessage(env.BOT_TOKEN, chatId, prompt);
  }

  if (data === "main_menu") {
    await setMode(env, chatId, "menu");
    await answerCallback(env.BOT_TOKEN, query.id);

    return sendMainMenu(env.BOT_TOKEN, chatId);
  }

  if (data.startsWith("preview:")) {
    await answerCallback(env.BOT_TOKEN, query.id);

    return showPersonPreview(
      env,
      chatId,
      data.slice(8)
    );
  }
}

/* TELEGRAM NAME SEARCH */

async function searchByName(env, chatId, text) {
  const query = normalizeName(text);

  if (!query) {
    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      "👤 تکایە ناوێک بنووسە."
    );
  }

  const people = await getAllPeopleForSearch(env);

  const results = deduplicateExactRecords(
    people.filter(p => exactNamePhraseMatch(p.name, query))
  ).slice(0, MAX_RESULTS);

  if (!results.length) {
    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      `❌ ئەم ناوە نەدۆزرایەوە.\n\n🔎 «${text}»`
    );
  }

  const buttons = results.map(p => [{
    text: makePersonLabel(p),
    callback_data: `preview:${String(p.id)}`.slice(0, 64)
  }]);

  buttons.push([
    { text: "⬅️ گەڕانەوە", callback_data: "main_menu" }
  ]);

  return sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `🔎 ${results.length} ئەنجام دۆزرایەوە.`,
    buttons
  );
}

/* TELEGRAM PHONE SEARCH */

async function searchByPhone(env, chatId, text) {
  const query = normalizePhone(text);

  if (!query) {
    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      "📱 تکایە ژمارەی تەلەفون بنووسە."
    );
  }

  const people = await getAllPeopleForSearch(env);

  const results = deduplicateExactRecords(
    people.filter(p =>
      normalizePhone(p.phone).includes(query)
    )
  ).slice(0, MAX_RESULTS);

  if (!results.length) {
    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ هیچ کەسێک بەو ژمارەیە نەدۆزرایەوە."
    );
  }

  const buttons = results.map(p => [{
    text: makePersonLabel(p),
    callback_data: `preview:${String(p.id)}`.slice(0, 64)
  }]);

  buttons.push([
    { text: "⬅️ گەڕانەوە", callback_data: "main_menu" }
  ]);

  return sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `📱 ${results.length} ئەنجام دۆزرایەوە.`,
    buttons
  );
}

/* TELEGRAM ELECTRICITY SEARCH */

async function searchByElectricity(env, chatId, text) {
  const query = normalizeSearchText(text);

  if (!query) {
    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      "⚡ تکایە ژمارە یان زانیاری کارەباکە بنووسە."
    );
  }

  const people = await getAllPeopleForSearch(env);

  const results = deduplicateExactRecords(
    people.filter(p =>
      normalizeSearchText(p.electricity).includes(query)
    )
  ).slice(0, MAX_RESULTS);

  if (!results.length) {
    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      `❌ هیچ تۆمارێک بۆ ئەم زانیارییەی کارەبا نەدۆزرایەوە.\n\n⚡ «${text}»`
    );
  }

  const buttons = results.map(p => [{
    text: makePersonLabel(p),
    callback_data: `preview:${String(p.id)}`.slice(0, 64)
  }]);

  buttons.push([
    { text: "⬅️ گەڕانەوە", callback_data: "main_menu" }
  ]);

  return sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `⚡ ${results.length} ئەنجامی گەڕانی کارەبا دۆزرایەوە.`,
    buttons
  );
}

/* PERSON LABEL */

function makePersonLabel(p) {
  const name = String(p?.name || "بێ ناو")
    .trim()
    .replace(/\s+/g, " ");

  const city = getCity(p);
  const age = getAge(p);

  const suffix = [city, age ? `${age} ساڵ` : ""]
    .filter(Boolean)
    .join(" — ");

  const full = [name, suffix]
    .filter(Boolean)
    .join(" — ");

  if (full.length <= 64) return full;

  const ending = suffix ? ` — ${suffix}` : "";

  return `${name.slice(
    0,
    Math.max(5, 61 - ending.length)
  ).trim()}…${ending}`.slice(0, 64);
}

/* AGE */

function getAge(p) {
  const birth = getBirth(p);
  const year = Number(birth);
  const now = new Date().getFullYear();

  return (
    birth &&
    Number.isFinite(year) &&
    year >= 1900 &&
    year <= now &&
    now - year <= 130
  ) ? String(now - year) : "";
}

/* CITY */

function getCity(p) {
  const text = normalizeDigits(
    String(p?.more || "").trim()
  );

  if (!text) return "";

  const patterns = [
    /(?:^|\n)\s*(?:شار|شاری)\s*[:：=-]?\s*([^\n|,،;]+)/iu,
    /(?:^|\n)\s*(?:city|city\s*name)\s*[:：=-]?\s*([^\n|,،;]+)/iu,
    /(?:^|\n)\s*(?:مدينة|المحافظة|محافظة)\s*[:：=-]?\s*([^\n|,،;]+)/iu
  ];

  for (const re of patterns) {
    const match = text.match(re);

    if (match?.[1]) {
      return match[1]
        .trim()
        .replace(/[.،,;|]+$/g, "")
        .replace(/\s+/g, " ");
    }
  }

  return "";
}

/* PERSON PREVIEW */

async function showPersonPreview(env, chatId, id) {
  const p = await getPerson(env, id);

  if (!p) {
    return sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ داتا نەدۆزرایەوە."
    );
  }

  return sendMessage(
    env.BOT_TOKEN,
    chatId,
    `👤 ناو: ${p.name || "نییە"}\n\n` +
    `📱 ژمارەی تەلەفون: ${p.phone || "نییە"}\n\n` +
    `⚡ زانیاری کارەبا: ${p.electricity || "نییە"}\n\n` +
    `📋 هەموو زانیارییەکان:\n${p.more || "هیچ زانیارییەکی زیادە نییە."}`
  );
}

async function getPerson(env, id) {
  return env.DB.prepare(
    `SELECT id, name, phone, more, electricity
     FROM people
     WHERE id = ?
     LIMIT 1`
  ).bind(String(id || "").trim()).first();
}

/* DEDUPLICATE RESULTS ONLY
 * Never merge different people with the same name.
 */

function deduplicateExactRecords(people) {
  const seen = new Set();
  const out = [];

  for (const p of people || []) {
    const key = p?.id != null
      ? `id:${String(p.id)}`
      : `record:${normalizeName(p?.name)}|${normalizePhone(p?.phone)}|${String(p?.more || "").trim()}|${normalizeSearchText(p?.electricity)}`;

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(p);
  }

  return out;
}

/* NORMALIZE DIGITS */

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[٠-٩]/g, d =>
      String(d.charCodeAt(0) - 0x0660)
    )
    .replace(/[۰-۹]/g, d =>
      String(d.charCodeAt(0) - 0x06F0)
    );
}

/* BIRTH YEAR */

function getBirth(p) {
  const more = normalizeDigits(
    String(p?.more || "")
  );

  if (!more.trim()) return "";

  const labeled = more.match(
    /(?:موالید|موڵید|میلاد|لەدایکبوون|لەدایک‌بوون|ساڵی\s*لەدایکبوون|ساڵی\s*لە\s*دایک\s*بوون|birth|year\s*of\s*birth)[^\d]{0,50}((?:18|19|20)\d{2})/i
  );

  if (labeled) return labeled[1];

  const year = more.match(
    /(?:^|[^\d])((?:18|19|20)\d{2})(?:$|[^\d])/m
  );

  return year ? year[1] : "";
}

/* NORMALIZE NAME */

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

/* NORMALIZE SEARCH TEXT */

function normalizeSearchText(value) {
  return normalizeDigits(String(value || ""))
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/* EXACT NAME PHRASE MATCH */

function exactNamePhraseMatch(name, search) {
  const full = normalizeName(name);
  const query = normalizeName(search);

  if (!full || !query) return false;

  const nameWords = full.split(/\s+/);
  const queryWords = query.split(/\s+/);

  if (queryWords.length > nameWords.length) {
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

    if (match) return true;
  }

  return false;
}

/* NORMALIZE PHONE */

function normalizePhone(value) {
  return normalizeDigits(value)
    .replace(/[^\d+]/g, "");
}

/* MAIN TELEGRAM MENU */

async function sendMainMenu(token, chatId) {
  return sendMessageWithKeyboard(
    token,
    chatId,
    "بەخێربێیت 👋\n\nتکایە دانەیەکیان هەڵبژێرە:",
    [
      [
        {
          text: "👤 گەڕان بە ناو",
          callback_data: "search_name"
        }
      ],
      [
        {
          text: "📱 ژمارەی تەلەفون",
          callback_data: "search_phone"
        }
      ],
      [
        {
          text: "⚡ گەڕان بە کارەبا",
          callback_data: "search_electricity"
        }
      ]
    ]
  );
}

/* SEND TELEGRAM MESSAGE */

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

/* SEND TELEGRAM MESSAGE WITH BUTTONS */

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

/* ANSWER TELEGRAM CALLBACK */

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

/* SAVE TELEGRAM SEARCH MODE */

async function setMode(env, chatId, mode) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS bot_sessions (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'menu'
    )`
  ).run();

  await env.DB.prepare(
    `INSERT INTO bot_sessions (chat_id, mode)
     VALUES (?, ?)
     ON CONFLICT(chat_id)
     DO UPDATE SET mode = excluded.mode`
  ).bind(String(chatId), mode).run();
}

/* GET TELEGRAM SEARCH MODE */

async function getMode(env, chatId) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS bot_sessions (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'menu'
    )`
  ).run();

  const row = await env.DB.prepare(
    "SELECT mode FROM bot_sessions WHERE chat_id = ?"
  ).bind(String(chatId)).first();

  return row?.mode || "menu";
}
