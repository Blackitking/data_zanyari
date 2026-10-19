const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://blackitking.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Import-Key",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const WORKER_VERSION = "2026-10-19-DATA-ZANYARI-V16-FLEXIBLE-SEARCH-1M";

// سنووری گەڕان: یەک ملیۆن تۆمار
const SEARCH_BATCH_SIZE = 5000;
const MAX_SEARCH_ROWS = 1000000;
const MAX_RESULTS = 50;

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

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return response(
          `Data Zanyari Worker is running.\nVersion: ${WORKER_VERSION}`
        );
      }

      if (url.pathname === "/api/search/name" && request.method === "GET") {
        return await searchNameAPI(request, env);
      }

      if (url.pathname === "/api/search/phone" && request.method === "GET") {
        return await searchPhoneAPI(request, env);
      }

      if (
        url.pathname === "/api/search/electricity" &&
        request.method === "GET"
      ) {
        return await searchElectricityAPI(request, env);
      }

      if (url.pathname === "/api/import" && request.method === "POST") {
        return await importPeople(request, env);
      }

      if (url.pathname === "/api/deduplicate" && request.method === "POST") {
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
      return json(
        { ok: false, error: "Internal server error" },
        500
      );
    }
  }
};


// ==================================================
// پشکنینی داتابەیس و زیادکردنی ستوونی کارەبا ئەگەر پێویست بوو
// هیچ تۆمارێک ناسڕدرێتەوە
// ==================================================

async function ensurePeopleSchema(env) {
  if (!env.DB) {
    throw new Error("D1 binding DB is missing");
  }

  const info = await env.DB
    .prepare("PRAGMA table_info(people)")
    .all();

  const columns = info.results || [];

  if (!columns.length) {
    throw new Error("D1 table people does not exist");
  }

  if (!columns.some(c => c.name === "electricity")) {
    try {
      await env.DB.prepare(
        "ALTER TABLE people ADD COLUMN electricity TEXT NOT NULL DEFAULT ''"
      ).run();

    } catch (error) {
      const again = await env.DB
        .prepare("PRAGMA table_info(people)")
        .all();

      if (!(again.results || []).some(c => c.name === "electricity")) {
        throw error;
      }
    }
  }
}


// ==================================================
// گەڕان بە ناو
// ==================================================

async function searchNameAPI(request, env) {
  try {
    await ensurePeopleSchema(env);

    const q = normalizeName(
      new URL(request.url).searchParams.get("q") || ""
    );

    if (!q) {
      return json({
        ok: true,
        people: [],
        count: 0
      });
    }

    const results = await searchPeopleInD1(
      env,
      person => flexibleNameMatch(person.name, q)
    );

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


// ==================================================
// گەڕان بە ژمارەی تەلەفون
// ==================================================

async function searchPhoneAPI(request, env) {
  try {
    await ensurePeopleSchema(env);

    const q = normalizePhone(
      new URL(request.url).searchParams.get("q") || ""
    );

    if (!q) {
      return json({
        ok: true,
        people: [],
        count: 0
      });
    }

    const results = await searchPeopleInD1(
      env,
      person => normalizePhone(person.phone).includes(q)
    );

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


// ==================================================
// گەڕان بە زانیاریی کارەبا
// ==================================================

async function searchElectricityAPI(request, env) {
  try {
    await ensurePeopleSchema(env);

    const q = normalizeSearchText(
      new URL(request.url).searchParams.get("q") || ""
    );

    if (!q) {
      return json({
        ok: true,
        people: [],
        count: 0
      });
    }

    const results = await searchPeopleInD1(
      env,
      person =>
        normalizeSearchText(person.electricity || "").includes(q)
    );

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


// ==================================================
// گەڕانی بەش بە بەش تا یەک ملیۆن تۆمار
// بۆ ئەوەی هەموو داتا لە یەکجاردا نەخرێتە ناو بیرگە
// ==================================================

async function searchPeopleInD1(env, matcher) {
  if (!env.DB) {
    throw new Error("D1 binding DB is missing");
  }

  const found = [];
  const seen = new Set();

  for (
    let offset = 0;
    offset < MAX_SEARCH_ROWS && found.length < MAX_RESULTS;
    offset += SEARCH_BATCH_SIZE
  ) {
    const result = await env.DB.prepare(
      `SELECT id, name, phone, electricity, more
       FROM people
       ORDER BY rowid ASC
       LIMIT ? OFFSET ?`
    )
      .bind(SEARCH_BATCH_SIZE, offset)
      .all();

    const rows = result.results || [];

    for (const person of rows) {
      if (!matcher(person)) {
        continue;
      }

      const key = person?.id != null
        ? `id:${String(person.id)}`
        : `record:${normalizeName(person?.name)}|${normalizePhone(person?.phone)}|${normalizeSearchText(person?.electricity || "")}|${String(person?.more || "").trim()}`;

      if (!seen.has(key)) {
        seen.add(key);
        found.push(person);
      }

      if (found.length >= MAX_RESULTS) {
        break;
      }
    }

    if (rows.length < SEARCH_BATCH_SIZE) {
      break;
    }
  }

  return found;
}


// ==================================================
// گواستنەوەی داتا بۆ D1
// تۆماری نوێ زیاد دەکات و تۆماری کۆن ناسڕێتەوە
// ==================================================

async function importPeople(request, env) {
  if (
    !env.IMPORT_KEY ||
    request.headers.get("X-Import-Key") !== env.IMPORT_KEY
  ) {
    return response("Unauthorized", 401);
  }

  try {
    await ensurePeopleSchema(env);

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
      const chunk = body.people.slice(i, i + 50).map(person => ({
        id: String(person?.id || crypto.randomUUID()),
        name: String(person?.name || ""),
        phone: String(person?.phone || ""),
        electricity: String(person?.electricity || ""),
        more: String(person?.more || "")
      }));

      for (const person of chunk) {
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO people
           (id, name, phone, electricity, more)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(
            person.id,
            person.name,
            person.phone,
            person.electricity,
            person.more
          )
          .run();

        if (Number(result?.meta?.changes || 0) > 0) {
          imported++;

        } else {
          skipped++;

          if (person.electricity.trim()) {
            const update = await env.DB.prepare(
              `UPDATE people
               SET electricity = ?
               WHERE id = ?
               AND COALESCE(electricity, '') <> ?`
            )
              .bind(
                person.electricity,
                person.id,
                person.electricity
              )
              .run();

            electricityUpdated += Number(
              update?.meta?.changes || 0
            );
          }
        }
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


// ==================================================
// پشکنینی تۆمارە دووبارەکان
// تەنها پشکنینە؛ هیچ تۆمارێک ناسڕێتەوە
// ==================================================

async function deduplicateAPI(request, env) {
  if (
    !env.IMPORT_KEY ||
    request.headers.get("X-Import-Key") !== env.IMPORT_KEY
  ) {
    return response("Unauthorized", 401);
  }

  try {
    await ensurePeopleSchema(env);

    const result = await env.DB.prepare(
      `SELECT id, name, phone, electricity, more
       FROM people
       ORDER BY rowid ASC`
    ).all();

    const seen = new Set();
    let repeatedExactRecords = 0;

    for (const person of result.results || []) {
      const key =
        `${normalizeName(person.name)}|` +
        `${normalizePhone(person.phone)}|` +
        `${normalizeName(person.electricity || "")}|` +
        `${String(person.more || "").trim()}`;

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


// ==================================================
// ناردنی داتا بۆ تێلێگرام
// ==================================================

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

    body.people.forEach((person, index) => {
      text +=
        `========================\n` +
        `#${index + 1}\n` +
        `ناو: ${person?.name || "-"}\n` +
        `ژمارەی تەلەفون: ${person?.phone || "-"}\n` +
        `کارەبا: ${person?.electricity || "-"}\n` +
        `زانیاری زیاتر: ${person?.more || "-"}\n`;

      if (person?.id != null) {
        text += `ID: ${person.id}\n`;
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
      new Blob(
        [text],
        { type: "text/plain;charset=utf-8" }
      ),
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


// ==================================================
// بۆتی تێلێگرام
// ==================================================

async function handleTelegram(update, env) {
  await ensurePeopleSchema(env);

  if (update.callback_query) {
    return handleCallback(update.callback_query, env);
  }

  const message = update.message;

  if (!message?.text) {
    return;
  }

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


async function handleCallback(query, env) {
  const chatId = query.message?.chat?.id;

  if (!chatId) {
    return;
  }

  const data = query.data || "";

  if (
    data === "search_name" ||
    data === "search_phone" ||
    data === "search_electricity"
  ) {
    const mode =
      data === "search_name"
        ? "name"
        : data === "search_phone"
          ? "phone"
          : "electricity";

    await setMode(env, chatId, mode);
    await answerCallback(env.BOT_TOKEN, query.id);

    const prompts = {
      name: "👤 تکایە ناوی کەسە
