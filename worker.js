const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://blackitking.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Import-Key",
  "Access-Control-Max-Age": "86400"
};

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

    /* =========================
       CORS
       ========================= */

    if (request.method === "OPTIONS") {
      return response(null, 204);
    }

    /* =========================
       WEBSITE NAME SEARCH
       ========================= */

    if (
      url.pathname === "/api/search/name" &&
      request.method === "GET"
    ) {
      return searchNameAPI(request, env);
    }

    /* =========================
       WEBSITE PHONE SEARCH
       ========================= */

    if (
      url.pathname === "/api/search/phone" &&
      request.method === "GET"
    ) {
      return searchPhoneAPI(request, env);
    }

    /* =========================
       IMPORT
       ========================= */

    if (
      url.pathname === "/api/import" &&
      request.method === "POST"
    ) {
      return importPeople(request, env);
    }

    /* =========================
       TELEGRAM EXPORT
       ========================= */

    if (
      url.pathname === "/api/telegram/export" &&
      request.method === "POST"
    ) {
      return telegramExport(request, env);
    }

    /* =========================
       TELEGRAM WEBHOOK
       ========================= */

    if (
      url.pathname === "/telegram/webhook" &&
      request.method === "POST"
    ) {

      try {

        const update = await request.json();

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

    /* =========================
       ROOT
       ========================= */

    if (url.pathname === "/") {

      return new Response(
        "Data Zanyari Worker is running.",
        {
          status: 200,
          headers: CORS_HEADERS
        }
      );

    }

    return response(
      JSON.stringify({
        ok: false,
        error: "Not Found"
      }),
      404,
      {
        "Content-Type":
          "application/json; charset=utf-8"
      }
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
        people: []
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

    const words =
      search
        .split(/\s+/)
        .filter(Boolean);

    const results =
      people
        .filter(person => {

          const name =
            normalizeName(person.name);

          const more =
            normalizeName(person.more);

          if (
            name.includes(search)
          ) {
            return true;
          }

          const nameWords =
            name
              .split(/\s+/)
              .filter(Boolean);

          const allWords =
            words.every(word =>
              nameWords.some(nameWord =>
                nameWord.includes(word)
              )
            );

          if (allWords) {
            return true;
          }

          if (
            more &&
            more.includes(search)
          ) {
            return true;
          }

          return false;

        })
        .slice(0, 50);

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

    return json(
      {
        ok: false,
        error: String(error)
      },
      500
    );

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
        people: []
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

    const results =
      people
        .filter(person => {

          return normalizePhone(
            person.phone
          ).includes(phone);

        })
        .slice(0, 50);

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

    return json(
      {
        ok: false,
        error: String(error)
      },
      500
    );

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

      return json(
        {
          ok: false,
          error: "people must be an array"
        },
        400
      );

    }

    /*
       داتاکانی کۆن نایسڕێنەوە.
       INSERT OR REPLACE تەنها ئەو ID ـەی هەمانە نوێ دەکات.
    */

    for (
      let i = 0;
      i < people.length;
      i += 50
    ) {

      const chunk =
        people.slice(
          i,
          i + 50
        );

      const statements =
        chunk.map(person => {

          const id =
            String(
              person.id ||
              crypto.randomUUID()
            );

          const name =
            String(
              person.name || ""
            );

          const phone =
            String(
              person.phone || ""
            );

          const more =
            String(
              person.more || ""
            );

          return env.DB
            .prepare(`
              INSERT OR REPLACE INTO people
              (id, name, phone, more)
              VALUES (?, ?, ?, ?)
            `)
            .bind(
              id,
              name,
              phone,
              more
            );

        });

      await env.DB.batch(
        statements
      );

    }

    return json({
      ok: true,
      imported: people.length
    });

  } catch (error) {

    console.error(
      "IMPORT ERROR:",
      error
    );

    return json(
      {
        ok: false,
        error: String(error)
      },
      500
    );

  }

}


/* =====================================================
   TELEGRAM EXPORT
   ===================================================== */

async function telegramExport(
  request,
  env
) {

  try {

    /*
       Telegram Bot Token
       دەبێت لە Cloudflare Secret بێت
       بە ناوی BOT_TOKEN
    */

    if (!env.BOT_TOKEN) {

      return json(
        {
          ok: false,
          error: "BOT_TOKEN is not configured"
        },
        500
      );

    }

    /*
       Telegram Admin ID
    */

    if (!env.ADMIN_ID) {

      return json(
        {
          ok: false,
          error: "ADMIN_ID is not configured"
        },
        500
      );

    }

    const body =
      await request.json();

    const people =
      body.people;

    if (!Array.isArray(people)) {

      return json(
        {
          ok: false,
          error: "people must be an array"
        },
        400
      );

    }

    if (!people.length) {

      return json(
        {
          ok: false,
          error: "No data to export"
        },
        400
      );

    }

    /*
       هەموو داتا دەکەینە ناو یەک فایل TXT.
       ئەمە تەنها یەک fetch بۆ Telegram دەکات.
       بەم شێوەیە کێشەی Too many subrequests
       لە Worker ـەکە دروست نابێت.
    */

    let text =
      "گەڕانی ناوەکان - Export\n" +
      "========================\n\n";

    text +=
      `کۆی تۆمارەکان: ${people.length}\n\n`;

    for (
      let i = 0;
      i < people.length;
      i++
    ) {

      const person =
        people[i] || {};

      text +=
        "========================\n";

      text +=
        `#${i + 1}\n`;

      text +=
        `ناو: ${person.name || "-"}\n`;

      text +=
        `ژمارەی تەلەفون: ${person.phone || "-"}\n`;

      text +=
        `زانیاری زیاتر: ${person.more || "-"}\n`;

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

    /*
       دروستکردنی فایل
    */

    const file =
      new Blob(
        [text],
        {
          type:
            "text/plain; charset=utf-8"
        }
      );

    /*
       FormData
    */

    const form =
      new FormData();

    form.append(
      "chat_id",
      String(env.ADMIN_ID)
    );

    form.append(
      "caption",
      `📦 هەموو داتا\n📊 کۆی تۆمارەکان: ${people.length}`
    );

    form.append(
      "document",
      file,
      "people-export.txt"
    );

    /*
       تەنها یەک داواکاری بۆ Telegram
    */

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

    /*
       ئەگەر Telegram rate limit کرد
    */

    if (
      !telegramResponse.ok ||
      !telegramResult.ok
    ) {

      console.error(
        "TELEGRAM EXPORT ERROR:",
        telegramResult
      );

      return json(
        {
          ok: false,
          error:
            telegramResult.description ||
            "Telegram API error"
        },
        500
      );

    }

    return json({
      ok: true,
      exported:
        people.length,
      type:
        "txt"
    });

  } catch (error) {

    console.error(
      "TELEGRAM EXPORT ERROR:",
      error
    );

    return json(
      {
        ok: false,
        error: String(error)
      },
      500
    );

  }

}


/* =====================================================
   TELEGRAM
   ===================================================== */

async function handleTelegram(
  update,
  env
) {

  if (
    update.callback_query
  ) {

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

  if (
    String(chatId) !==
    String(env.ADMIN_ID)
  ) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "ببورە، ئەم بۆتە تەنها بۆ بەکارهێنانی ڕێگەپێدراوە."
    );

    return;
  }

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
      `📊 کۆی داتا: ${result?.count || 0}`
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

  if (
    String(chatId) !==
    String(env.ADMIN_ID)
  ) {

    await answerCallback(
      env.BOT_TOKEN,
      query.id,
      "ڕێگەپێدراو نییت."
    );

    return;
  }

  const data =
    query.data || "";

  if (
    data === "search_name"
  ) {

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

  if (
    data === "search_phone"
  ) {

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

  if (
    data === "main_menu"
  ) {

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

  if (
    data.startsWith("person:")
  ) {

    const id =
      data.slice(7);

    await answerCallback(
      env.BOT_TOKEN,
      query.id
    );

    await showPerson(
      env,
      chatId,
      id
    );

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

  const words =
    search
      .split(/\s+/)
      .filter(Boolean);

  const results =
    people
      .filter(person => {

        const fullName =
          normalizeName(
            person.name
          );

        const more =
          normalizeName(
            person.more
          );

        if (
          fullName.includes(search)
        ) {
          return true;
        }

        const nameWords =
          fullName
            .split(/\s+/)
            .filter(Boolean);

        const matches =
          words.every(word =>
            nameWords.some(nameWord =>
              nameWord.includes(word)
            )
          );

        if (matches) {
          return true;
        }

        if (
          more &&
          more.includes(search)
        ) {
          return true;
        }

        return false;

      })
      .slice(0, 50);

  if (!results.length) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `❌ هیچ ئەنجامێک بۆ «${text}» نەدۆزرایەوە.`
    );

    return;
  }

  const buttons =
    results.map(person => {

      const birth =
        getBirth(person);

      const title =
        birth
          ? `👤 ${person.name || "بێ ناو"} — 📅 ${birth}`
          : `👤 ${person.name || "بێ ناو"}`;

      return [
        {
          text:
            title.slice(0, 60),

          callback_data:
            `person:${String(person.id)}`
        }
      ];

    });

  buttons.push([
    {
      text: "⬅️ گەڕانەوە",
      callback_data: "main_menu"
    }
  ]);

  await sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `🔎 ${results.length} ئەنجام دۆزرایەوە.\n\nیەکێکیان هەڵبژێرە:`,
    buttons
  );

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

  const results =
    people
      .filter(person =>
        normalizePhone(
          person.phone
        ).includes(phone)
      )
      .slice(0, 50);

  if (!results.length) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ هیچ کەسێک بەو ژمارەیە نەدۆزرایەوە."
    );

    return;
  }

  const buttons =
    results.map(person => {

      const birth =
        getBirth(person);

      const label =
        birth
          ? `👤 ${person.name || "بێ ناو"} — 📅 ${birth}`
          : `👤 ${person.name || "بێ ناو"}`;

      return [
        {
          text:
            label.slice(0, 60),

          callback_data:
            `person:${String(person.id)}`
        }
      ];

    });

  buttons.push([
    {
      text: "⬅️ گەڕانەوە",
      callback_data: "main_menu"
    }
  ]);

  await sendMessageWithKeyboard(
    env.BOT_TOKEN,
    chatId,
    `📱 ${results.length} ئەنجام دۆزرایەوە.\n\nیەکێکیان هەڵبژێرە:`,
    buttons
  );

}


/* =====================================================
   SHOW PERSON
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
    `👤 ناو: ${person.name || "-"}`;

  text +=
    `\n📅 موالید: ${birth || "لە داتا نییە"}`;

  text +=
    `\n📱 تەلەفون: ${person.phone || "-"}`;

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
          text: "⬅️ گەڕانەوە بۆ سەرەتا",
          callback_data: "main_menu"
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
      LIMIT 10000
    `).all();

  return result.results || [];

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
   BIRTH
   ===================================================== */

function getBirth(person) {

  const more =
    String(
      person.more || ""
    );

  const labeled =
    more.match(
      /(?:موالید|موڵید|میلاد|لەدایکبوون|birth|ساڵ)[^\d]{0,15}((?:19|20)\d{2})/i
    );

  if (labeled) {
    return labeled[1];
  }

  const year =
    more.match(
      /\b((?:19|20)\d{2})\b/
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

  if (
    !text ||
    !birth
  ) {
    return text;
  }

  text =
    text.replace(
      new RegExp(
        `(?:موالید|موڵید|میلاد|لەدایکبوون|birth|ساڵ)[^\\d]{0,15}${birth}`,
        "i"
      ),
      ""
    );

  return text.trim();

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
          text: "👤 گەڕان بە ناو",
          callback_data: "search_name"
        }
      ],
      [
        {
          text: "📱 ژمارەی تەلەفون",
          callback_data: "search_phone"
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
        chat_id: chatId,

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
        chat_id: chatId,

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

        show_alert: false
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

  return row?.mode || "menu";

}


/* =====================================================
   NORMALIZE NAME
   ===================================================== */

function normalizeName(value) {

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
      /[،,؛;|/\\()[\]{}:_"'`]/g,
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

function normalizePhone(value) {

  return String(
    value || ""
  ).replace(
    /[^\d+]/g,
    ""
  );

}
