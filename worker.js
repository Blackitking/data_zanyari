const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://blackitking.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Import-Key",
  "Access-Control-Max-Age": "86400"
};

const WORKER_VERSION = "2026-10-06-DATA-ZANYARI-V10";

function response(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      ...headers
    }
  });
}

function json(data, status = 200) {
  return response(
    JSON.stringify(data),
    status,
    {
      "Content-Type": "application/json; charset=utf-8"
    }
  );
}

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return response(null, 204);
    }

    if (
      url.pathname === "/api/search/name" &&
      request.method === "GET"
    ) {
      return searchNameAPI(request, env);
    }

    if (
      url.pathname === "/api/search/phone" &&
      request.method === "GET"
    ) {
      return searchPhoneAPI(request, env);
    }

    if (
      url.pathname === "/api/import" &&
      request.method === "POST"
    ) {
      return importPeople(request, env);
    }

    if (
      url.pathname === "/api/deduplicate" &&
      request.method === "POST"
    ) {
      return deduplicateAPI(request, env);
    }

    if (
      url.pathname === "/api/telegram/export" &&
      request.method === "POST"
    ) {
      return telegramExport(request, env);
    }

    if (
      url.pathname === "/telegram/webhook" &&
      request.method === "POST"
    ) {

      try {

        const update =
          await request.json();

        await handleTelegram(
          update,
          env
        );

        return new Response(
          "OK",
          {
            status: 200,
            headers: CORS_HEADERS
          }
        );

      } catch (error) {

        console.error(
          "TELEGRAM ERROR:",
          error
        );

        return new Response(
          "ERROR",
          {
            status: 500,
            headers: CORS_HEADERS
          }
        );

      }

    }

    if (url.pathname === "/") {

      return new Response(
        `Data Zanyari Worker is running.\nVersion: ${WORKER_VERSION}`,
        {
          status: 200,
          headers: CORS_HEADERS
        }
      );

    }

    return json(
      {
        ok: false,
        error: "Not Found"
      },
      404
    );

  }

};


/* =====================================================
   WEBSITE NAME SEARCH API
   ===================================================== */

async function searchNameAPI(request, env) {

  try {

    const url =
      new URL(request.url);

    const query =
      url.searchParams.get("q") || "";

    const search =
      normalizeName(query);

    if (!search) {

      return json({
        ok: true,
        people: [],
        count: 0
      });

    }

    const result =
      await env.DB.prepare(`
        SELECT id, name, phone, more
        FROM people
        WHERE name IS NOT NULL
        LIMIT 10000
      `).all();

    const people =
      result.results || [];

    const matched =
      people.filter(person =>
        exactNamePhraseMatch(
          person.name,
          search
        )
      );

    const results =
      deduplicatePeopleByName(
        matched
      ).slice(0, 50);

    return json({
      ok: true,
      people: results,
      count: results.length
    });

  } catch (error) {

    console.error(
      "NAME API ERROR:",
      error
    );

    return json({
      ok: false,
      error: String(error)
    }, 500);

  }

}


/* =====================================================
   WEBSITE PHONE SEARCH API
   ===================================================== */

async function searchPhoneAPI(request, env) {

  try {

    const url =
      new URL(request.url);

    const query =
      url.searchParams.get("q") || "";

    const phone =
      normalizePhone(query);

    if (!phone) {

      return json({
        ok: true,
        people: [],
        count: 0
      });

    }

    const result =
      await env.DB.prepare(`
        SELECT id, name, phone, more
        FROM people
        WHERE phone IS NOT NULL
        LIMIT 10000
      `).all();

    const people =
      result.results || [];

    const matched =
      people.filter(person =>
        normalizePhone(
          person.phone
        ).includes(phone)
      );

    const results =
      deduplicatePeopleByName(
        matched
      ).slice(0, 50);

    return json({
      ok: true,
      people: results,
      count: results.length
    });

  } catch (error) {

    console.error(
      "PHONE API ERROR:",
      error
    );

    return json({
      ok: false,
      error: String(error)
    }, 500);

  }

}


/* =====================================================
   IMPORT PEOPLE
   ===================================================== */

async function importPeople(request, env) {

  try {

    const key =
      request.headers.get(
        "X-Import-Key"
      );

    if (
      !env.IMPORT_KEY ||
      key !== env.IMPORT_KEY
    ) {

      return response(
        "Unauthorized",
        401
      );

    }

    const body =
      await request.json();

    const people =
      body.people;

    if (!Array.isArray(people)) {

      return json({
        ok: false,
        error:
          "people must be an array"
      }, 400);

    }

    const uniquePeople =
      deduplicatePeopleByName(
        people.map(person => ({
          id:
            String(
              person.id ||
              crypto.randomUUID()
            ),

          name:
            String(
              person.name || ""
            ),

          phone:
            String(
              person.phone || ""
            ),

          more:
            String(
              person.more || ""
            )
        }))
      );

    for (
      let i = 0;
      i < uniquePeople.length;
      i += 50
    ) {

      const chunk =
        uniquePeople.slice(
          i,
          i + 50
        );

      const statements =
        chunk.map(person => {

          return env.DB
            .prepare(`
              INSERT OR REPLACE INTO people
              (id, name, phone, more)
              VALUES (?, ?, ?, ?)
            `)
            .bind(
              String(person.id),
              String(person.name),
              String(person.phone),
              String(person.more)
            );

        });

      await env.DB.batch(
        statements
      );

    }

    const cleanup =
      await deduplicateDatabase(
        env
      );

    return json({
      ok: true,
      imported:
        uniquePeople.length,
      duplicatesRemoved:
        cleanup.deleted
    });

  } catch (error) {

    console.error(
      "IMPORT ERROR:",
      error
    );

    return json({
      ok: false,
      error: String(error)
    }, 500);

  }

}


/* =====================================================
   MANUAL DEDUPLICATE API
   ===================================================== */

async function deduplicateAPI(request, env) {

  try {

    const key =
      request.headers.get(
        "X-Import-Key"
      );

    if (
      !env.IMPORT_KEY ||
      key !== env.IMPORT_KEY
    ) {

      return response(
        "Unauthorized",
        401
      );

    }

    const result =
      await deduplicateDatabase(
        env
      );

    return json({
      ok: true,
      message:
        "دووبارەکان سڕانەوە.",
      duplicatesRemoved:
        result.deleted,
      remaining:
        result.remaining
    });

  } catch (error) {

    console.error(
      "DEDUPLICATE ERROR:",
      error
    );

    return json({
      ok: false,
      error: String(error)
    }, 500);

  }

}


/* =====================================================
   DEDUPLICATE DATABASE
   ===================================================== */

async function deduplicateDatabase(env) {

  const result =
    await env.DB.prepare(`
      SELECT id, name, phone, more
      FROM people
      WHERE name IS NOT NULL
      ORDER BY rowid ASC
      LIMIT 10000
    `).all();

  const people =
    result.results || [];

  const seen =
    new Set();

  const duplicateIds =
    [];

  for (const person of people) {

    const name =
      normalizeName(
        person.name
      );

    if (!name) {
      continue;
    }

    if (seen.has(name)) {

      duplicateIds.push(
        String(person.id)
      );

    } else {

      seen.add(name);

    }

  }

  let deleted = 0;

  for (
    let i = 0;
    i < duplicateIds.length;
    i += 40
  ) {

    const chunk =
      duplicateIds.slice(
        i,
        i + 40
      );

    const statements =
      chunk.map(id =>
        env.DB
          .prepare(`
            DELETE FROM people
            WHERE id = ?
          `)
          .bind(id)
      );

    if (statements.length) {

      await env.DB.batch(
        statements
      );

      deleted +=
        statements.length;

    }

  }

  const countResult =
    await env.DB
      .prepare(
        "SELECT COUNT(*) AS count FROM people"
      )
      .first();

  return {
    deleted,
    remaining:
      Number(
        countResult?.count || 0
      )
  };

}


/* =====================================================
   TELEGRAM EXPORT
   ===================================================== */

async function telegramExport(request, env) {

  try {

    if (!env.BOT_TOKEN) {

      return json({
        ok: false,
        error:
          "BOT_TOKEN is not configured"
      }, 500);

    }

    if (!env.ADMIN_ID) {

      return json({
        ok: false,
        error:
          "ADMIN_ID is not configured"
      }, 500);

    }

    const body =
      await request.json();

    const people =
      body.people;

    if (!Array.isArray(people)) {

      return json({
        ok: false,
        error:
          "people must be an array"
      }, 400);

    }

    if (!people.length) {

      return json({
        ok: false,
        error:
          "No data to export"
      }, 400);

    }

    const uniquePeople =
      deduplicatePeopleByName(
        people
      );

    let text =
      "گەڕانی ناوەکان - Export\n" +
      "========================\n\n";

    text +=
      `کۆی تۆمارەکان: ${uniquePeople.length}\n\n`;

    for (
      let i = 0;
      i < uniquePeople.length;
      i++
    ) {

      const person =
        uniquePeople[i] || {};

      text +=
        "========================\n";

      text +=
        `#${i + 1}\n`;

      text +=
        `ناو: ${
          person.name || "-"
        }\n`;

      text +=
        `ژمارەی تەلەفون: ${
          person.phone || "-"
        }\n`;

      text +=
        `زانیاری زیاتر: ${
          person.more || "-"
        }\n`;

      if (
        person.id !== undefined &&
        person.id !== null
      ) {

        text +=
          `ID: ${person.id}\n`;

      }

      text += "\n";

    }

    text +=
      "========================\n";

    text +=
      "کۆتایی داتا\n";

    const file =
      new Blob(
        [text],
        {
          type:
            "text/plain; charset=utf-8"
        }
      );

    const form =
      new FormData();

    form.append(
      "chat_id",
      String(env.ADMIN_ID)
    );

    form.append(
      "caption",
      `📦 هەموو داتا\n📊 کۆی تۆمارەکان: ${uniquePeople.length}`
    );

    form.append(
      "document",
      file,
      "people-export.txt"
    );

    const telegramResponse =
      await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
        {
          method: "POST",
          body: form
        }
      );

    let telegramResult;

    try {

      telegramResult =
        await telegramResponse.json();

    } catch {

      telegramResult = {
        ok: false,
        description:
          "Invalid Telegram response"
      };

    }

    if (
      !telegramResponse.ok ||
      !telegramResult.ok
    ) {

      console.error(
        "TELEGRAM EXPORT ERROR:",
        telegramResult
      );

      return json({
        ok: false,
        error:
          telegramResult.description ||
          "Telegram API error"
      }, 500);

    }

    return json({
      ok: true,
      exported:
        uniquePeople.length,
      duplicatesRemoved:
        people.length -
        uniquePeople.length,
      type: "txt"
    });

  } catch (error) {

    console.error(
      "TELEGRAM EXPORT ERROR:",
      error
    );

    return json({
      ok: false,
      error: String(error)
    }, 500);

  }

}


/* =====================================================
   TELEGRAM
   ===================================================== */

async function handleTelegram(update, env) {

  if (update.callback_query) {

    await handleCallback(
      update.callback_query,
      env
    );

    return;
  }

  const message =
    update.message;

  if (
    !message ||
    !message.text
  ) {
    return;
  }

  const chatId =
    message.chat.id;

  const text =
    message.text.trim();

  if (text === "/start") {

    await setMode(
      env,
      chatId,
      "menu"
    );

    await sendMainMenu(
      env.BOT_TOKEN,
      chatId
    );

    return;
  }

  if (text === "/count") {

    const result =
      await env.DB
        .prepare(
          "SELECT COUNT(*) AS count FROM people"
        )
        .first();

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `📊 کۆی داتا: ${
        result?.count || 0
      }`
    );

    return;
  }

  if (text === "/cleanup") {

    if (
      String(chatId) !==
      String(env.ADMIN_ID)
    ) {

      await sendMessage(
        env.BOT_TOKEN,
        chatId,
        "❌ ئەم فرمانە تەنها بۆ ئەدمینە."
      );

      return;
    }

    const result =
      await deduplicateDatabase(
        env
      );

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `✅ پاککردنەوە تەواو بوو.\n\n🗑️ دووبارە سڕایەوە: ${result.deleted}\n📊 داتای ماوە: ${result.remaining}`
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

  const mode =
    await getMode(
      env,
      chatId
    );

  if (mode === "name") {

    await searchByName(
      env,
      chatId,
      text
    );

    return;
  }

  if (mode === "phone") {

    await searchByPhone(
      env,
      chatId,
      text
    );

    return;
  }

  await sendMainMenu(
    env.BOT_TOKEN,
    chatId
  );

}


/* =====================================================
   TELEGRAM CALLBACK
   ===================================================== */

async function handleCallback(
  query,
  env
) {

  const chatId =
    query.message?.chat?.id;

  if (!chatId) {
    return;
  }

  const data =
    query.data || "";

  if (data === "search_name") {

    await setMode(
      env,
      chatId,
      "name"
    );

    await answerCallback(
      env.BOT_TOKEN,
      query.id
    );

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "👤 تکایە ناوی کەسەکە بنووسە:"
    );

    return;
  }

  if (data === "search_phone") {

    await setMode(
      env,
      chatId,
      "phone"
    );

    await answerCallback(
      env.BOT_TOKEN,
      query.id
    );

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "📱 تکایە ژمارەی تەلەفون بنووسە:"
    );

    return;
  }

  if (data === "main_menu") {

    await setMode(
      env,
      chatId,
      "menu"
    );

    await answerCallback(
      env.BOT_TOKEN,
      query.id
    );

    await sendMainMenu(
      env.BOT_TOKEN,
      chatId
    );

    return;
  }

  if (data.startsWith("preview:")) {

    const id =
      data.slice(
        "preview:".length
      );

    await answerCallback(
      env.BOT_TOKEN,
      query.id
    );

    await showPersonPreview(
      env,
      chatId,
      id
    );

    return;
  }

  if (data.startsWith("person:")) {

    const id =
      data.slice(
        "person:".length
      );

    await answerCallback(
      env.BOT_TOKEN,
      query.id
    );

    await showPerson(
      env,
      chatId,
      id
    );

    return;
  }

}


/* =====================================================
   TELEGRAM NAME SEARCH
   ===================================================== */

async function searchByName(
  env,
  chatId,
  text
) {

  const search =
    normalizeName(text);

  if (!search) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "👤 تکایە ناوێک بنووسە."
    );

    return;
  }

  const people =
    await getPeople(env);

  const matched =
    people.filter(person =>
      exactNamePhraseMatch(
        person.name,
        search
      )
    );

  const results =
    deduplicatePeopleByName(
      matched
    ).slice(0, 50);

  if (!results.length) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `❌ ببورە، ئەم ناوە نەدۆزرایەوە.\n\n🔎 «${text}»`
    );

    return;
  }

  const buttons = [];

  for (const person of results) {

    const birth =
      getBirth(person);

    const name =
      cleanDisplayName(
        person.name
      );

    const label =
      birth
        ? `${name} — ${birth}`
        : name;

    buttons.push([
      {
        text: label,
        callback_data:
          `preview:${String(person.id)}`
      }
    ]);

  }

  buttons.push([
    {
      text:
        "⬅️ گەڕانەوە",
      callback_data:
        "main_menu"
    }
  ]);

  await sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `🔎 ${results.length} ئەنجام دۆزرایەوە.`,
    buttons
  );

}


/* =====================================================
   CLEAN DISPLAY NAME
   ONLY REMOVES THE UNWANTED LABEL
   ===================================================== */

function cleanDisplayName(name) {

  let value =
    String(name || "").trim();

  if (!value) {
    return "بێ ناو";
  }

  value =
    value.replace(
      /(?:^|\s)زانیاری\s*کەسی(?:\s*✅)?(?=\s|$)/g,
      " "
    );

  value =
    value.replace(
      /(?:^|\s)زانیاری\s*کەسی(?:\s*✔️?|\s*☑️?)?(?=\s|$)/g,
      " "
    );

  value =
    value.replace(
      /(^|\s)✅(?=\s|$)/g,
      " "
    );

  value =
    value.replace(
      /\s+/g,
      " "
    )
    .trim();

  return value || "بێ ناو";

}


/* =====================================================
   SHORTEN LONG BUTTON NAME
   ===================================================== */

function shortenButtonName(
  name,
  maxLength = 42
) {

  const value =
    String(name || "").trim();

  if (value.length <= maxLength) {
    return value;
  }

  return (
    value.slice(
      0,
      maxLength - 1
    ).trim() +
    "…"
  );

}


/* =====================================================
   EXACT NAME PHRASE MATCH
   ===================================================== */

function exactNamePhraseMatch(
  name,
  search
) {

  const fullName =
    normalizeName(name);

  const query =
    normalizeName(search);

  if (!fullName || !query) {
    return false;
  }

  if (fullName === query) {
    return true;
  }

  if (
    fullName.startsWith(
      query + " "
    )
  ) {
    return true;
  }

  if (
    fullName.endsWith(
      " " + query
    )
  ) {
    return true;
  }

  if (
    fullName.includes(
      " " + query + " "
    )
  ) {
    return true;
  }

  return false;
}


/* =====================================================
   TELEGRAM PHONE SEARCH
   ===================================================== */

async function searchByPhone(
  env,
  chatId,
  text
) {

  const phone =
    normalizePhone(text);

  if (!phone) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "📱 تکایە ژمارەی تەلەفون بنووسە."
    );

    return;
  }

  const people =
    await getPeople(env);

  const matched =
    people.filter(person =>
      normalizePhone(
        person.phone
      ).includes(phone)
    );

  const results =
    deduplicatePeopleByName(
      matched
    ).slice(0, 50);

  if (!results.length) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ هیچ کەسێک بەو ژمارەیە نەدۆزرایەوە."
    );

    return;
  }

  const buttons = [];

  for (const person of results) {

    const birth =
      getBirth(person);

    const name =
      cleanDisplayName(
        person.name
      );

    const label =
      birth
        ? `${name} — ${birth}`
        : name;

    buttons.push([
      {
        text: label,
        callback_data:
          `preview:${String(person.id)}`
      }
    ]);

  }

  buttons.push([
    {
      text:
        "⬅️ گەڕانەوە",
      callback_data:
        "main_menu"
    }
  ]);

  await sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `📱 ${results.length} ئەنجام دۆزرایەوە.`,
    buttons
  );

}


/* =====================================================
   SHOW PERSON PREVIEW
   ===================================================== */

async function showPersonPreview(
  env,
  chatId,
  id
) {

  const person =
    await getPerson(
      env,
      id
    );

  if (!person) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ داتا نەدۆزرایەوە."
    );

    return;
  }

  const birth =
    getBirth(person);

  const name =
    cleanDisplayName(
      person.name || "-"
    );

  const text =
    birth
      ? `${name} — ${birth}`
      : name;

  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    text
  );

}


/* =====================================================
   SHOW PERSON FULL INFO
   ===================================================== */

async function showPerson(
  env,
  chatId,
  id
) {

  const person =
    await getPerson(
      env,
      id
    );

  if (!person) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ داتا نەدۆزرایەوە."
    );

    return;
  }

  const birth =
    getBirth(person);

  let text =
    `👤 ناو: ${
      person.name || "-"
    }`;

  text +=
    `\n📅 موالید: ${
      birth ||
      "لە داتا نییە"
    }`;

  text +=
    `\n📱 تەلەفون: ${
      person.phone || "-"
    }`;

  const more =
    cleanMore(
      person.more,
      birth
    );

  if (more) {

    text +=
      `\n📝 زانیاری زیاتر: ${more}`;

  }

  await sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    text,
    [
      [
        {
          text:
            "⬅️ گەڕانەوە بۆ سەرەتا",

          callback_data:
            "main_menu"
        }
      ]
    ]
  );

}


/* =====================================================
   GET PEOPLE
   ===================================================== */

async function getPeople(env) {

  const result =
    await env.DB.prepare(`
      SELECT id, name, phone, more
      FROM people
      ORDER BY rowid ASC
      LIMIT 10000
    `).all();

  return deduplicatePeopleByName(
    result.results || []
  );

}


/* =====================================================
   GET PERSON
   ===================================================== */

async function getPerson(
  env,
  id
) {

  const cleanId =
    String(id || "").trim();

  if (!cleanId) {
    return null;
  }

  let person =
    await env.DB
      .prepare(`
        SELECT id, name, phone, more
        FROM people
        WHERE id = ?
        LIMIT 1
      `)
      .bind(cleanId)
      .first();

  if (person) {
    return person;
  }

  const people =
    await getPeople(env);

  person =
    people.find(item =>
      String(item.id).trim() ===
      cleanId
    );

  return person || null;

}


/* =====================================================
   REMOVE DUPLICATES IN MEMORY
   ===================================================== */

function deduplicatePeopleByName(
  people
) {

  const seen =
    new Set();

  const result = [];

  for (const person of people || []) {

    const normalized =
      normalizeName(
        person?.name
      );

    if (!normalized) {

      result.push(person);

      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);

    result.push(person);

  }

  return result;

}


/* =====================================================
   DIGIT NORMALIZATION
   ===================================================== */

function normalizeDigits(value) {

  return String(value || "")

    .replace(
      /[٠-٩]/g,
      digit =>
        String(
          digit.charCodeAt(0) - 0x0660
        )
    )

    .replace(
      /[۰-۹]/g,
      digit =>
        String(
          digit.charCodeAt(0) - 0x06F0
        )
    );

}


/* =====================================================
   BIRTH
   ===================================================== */

function getBirth(person) {

  const original =
    String(
      person?.more || ""
    );

  if (!original.trim()) {
    return "";
  }

  const more =
    normalizeDigits(
      original
    );

  const labeled =
    more.match(
      /(?:موالید|موڵید|میلاد|لەدایکبوون|لەدایک‌بوون|ساڵی\s*لەدایکبوون|ساڵی\s*لە\s*دایک\s*بوون|birth|year\s*of\s*birth)[^\d]{0,50}((?:18|19|20)\d{2})/i
    );

  if (labeled) {
    return labeled[1];
  }

  const year =
    more.match(
      /(?:^|[^\d])((?:18|19|20)\d{2})(?:$|[^\d])/m
    );

  return year
    ? year[1]
    : "";

}


/* =====================================================
   CLEAN MORE
   ===================================================== */

function cleanMore(
  more,
  birth
) {

  let text =
    String(
      more || ""
    ).trim();

  if (!text) {
    return "";
  }

  if (!birth) {
    return text;
  }

  text =
    normalizeDigits(
      text
    );

  text =
    text.replace(
      new RegExp(
        `(?:موالید|موڵید|میلاد|لەدایکبوون|لەدایک‌بوون|ساڵی\\s*لەدایکبوون|ساڵی\\s*لە\\s*دایک\\s*بوون|birth|year\\s*of\\s*birth)[^\\d]{0,50}${birth}`,
        "i"
      ),
      ""
    );

  if (
    text.trim() === birth
  ) {
    return "";
  }

  return text
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();

}


/* =====================================================
   MAIN MENU
   ===================================================== */

async function sendMainMenu(
  token,
  chatId
) {

  await sendMessageWithKeyboard(
    token,
    chatId,
    "بەخێربێیت 👋\n\nتکایە دانەیەکیان هەڵبژێرە:",
    [
      [
        {
          text:
            "👤 گەڕان بە ناو",

          callback_data:
            "search_name"
        }
      ],
      [
        {
          text:
            "📱 ژمارەی تەلەفون",

          callback_data:
            "search_phone"
        }
      ]
    ]
  );

}


/* =====================================================
   SEND MESSAGE
   ===================================================== */

async function sendMessage(
  token,
  chatId,
  text
) {

  return fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json"
      },

      body: JSON.stringify({
        chat_id:
          chatId,

        text:
          String(text).slice(
            0,
            4000
          )
      })
    }
  );

}


/* =====================================================
   SEND MESSAGE + KEYBOARD
   ===================================================== */

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
        "content-type":
          "application/json"
      },

      body: JSON.stringify({
        chat_id:
          chatId,

        text:
          String(text).slice(
            0,
            4000
          ),

        reply_markup: {
          inline_keyboard:
            keyboard
        }
      })
    }
  );

}


/* =====================================================
   ANSWER CALLBACK
   ===================================================== */

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
        "content-type":
          "application/json"
      },

      body: JSON.stringify({
        callback_query_id:
          callbackId,

        text,

        show_alert:
          false
      })
    }
  );

}


/* =====================================================
   BOT SESSION
   ===================================================== */

async function setMode(
  env,
  chatId,
  mode
) {

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
  `)
  .bind(
    String(chatId),
    mode
  )
  .run();

}


async function getMode(
  env,
  chatId
) {

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'menu'
    )
  `).run();

  const row =
    await env.DB.prepare(`
      SELECT mode
      FROM bot_sessions
      WHERE chat_id = ?
    `)
    .bind(
      String(chatId)
    )
    .first();

  return row?.mode ||
    "menu";

}


/* =====================================================
   NORMALIZE NAME
   ===================================================== */

function normalizeName(
  value
) {

  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")

    .replace(
      /[ًٌٍَُِّْـ]/g,
      ""
    )

    .replace(
      /[يىئ]/g,
      "ی"
    )

    .replace(
      /ك/g,
      "ک"
    )

    .replace(
      /[ۀة]/g,
      "ە"
    )

    .replace(
      /ؤ/g,
      "ۆ"
    )

    .replace(
      /[أإآ]/g,
      "ا"
    )

    .replace(
      /[،,؛;|/\\()[\]{}:_"'`.-]/g,
      " "
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();

}


/* =====================================================
   NORMALIZE PHONE
   ===================================================== */

function normalizePhone(
  value
) {

  return normalizeDigits(
    value
  )
    .replace(
      /[^\d+]/g,
      ""
    );

}
