const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://blackitking.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Import-Key",
  "Access-Control-Max-Age": "86400"
};

function response(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, ...headers }
  });
}

function json(data, status = 200) {
  return response(JSON.stringify(data), status, {
    "Content-Type": "application/json"
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return response(null, 204);
    }

    if (url.pathname === "/api/import" && request.method === "POST") {
      return importPeople(request, env);
    }

    if (
      url.pathname === "/telegram/webhook" &&
      request.method === "POST"
    ) {
      try {
        const update = await request.json();

        await handleTelegram(update, env);

        return new Response("OK");
      } catch (error) {
        console.error("TELEGRAM ERROR:", error);

        return new Response("ERROR", {
          status: 500
        });
      }
    }

    if (url.pathname === "/") {
      return new Response(
        "Data Zanyari Worker is running."
      );
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};


/* =========================
   Import
   ========================= */

async function importPeople(request, env) {
  try {
    const key =
      request.headers.get("X-Import-Key");

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

    for (
      let i = 0;
      i < people.length;
      i += 50
    ) {
      const chunk =
        people.slice(i, i + 50);

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

          return env.DB.prepare(`
            INSERT OR REPLACE INTO people
            (id, name, phone, more)
            VALUES (?, ?, ?, ?)
          `).bind(
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


/* =========================
   Telegram
   ========================= */

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


/* =========================
   Callback
   ========================= */

async function handleCallback(query, env) {
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

  if (data.startsWith("person:")) {
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

    return;
  }
}


/* =========================
   گەڕانی ناو
   ========================= */

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

  const searchWords =
    search
      .split(/\s+/)
      .filter(Boolean);

  const results =
    people
      .filter(person => {
        const name =
          normalizeName(
            person.name
          );

        const more =
          normalizeName(
            person.more
          );

        /*
         * یەکەم:
         * ئەگەر هەموو گەڕانەکە
         * لە ناوەکەدا هەبوو،
         * ئەنجامەکە وەربگرە.
         */
        if (
          name.includes(search)
        ) {
          return true;
        }

        /*
         * دووەم:
         * هەر وشەی گەڕان دەبێت
         * لە ناوەکەدا هەبێت.
         */
        const allWordsMatch =
          searchWords.every(
            word =>
              name.includes(word)
          );

        if (allWordsMatch) {
          return true;
        }

        /*
         * سێیەم:
         * ئەگەر ناوی تەواو لە
         * more ـدا هەبێت،
         * ئەویش بدۆزەرەوە.
         */
        if (
          more.includes(search)
        ) {
          return true;
        }

        return searchWords.every(
          word =>
            more.includes(word)
        );
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

      const label =
        birth
          ? `👤 ${person.name || "بێ ناو"} — 📅 ${birth}`
          : `👤 ${person.name || "بێ ناو"}`;

      return [
        {
          text:
            label.slice(0, 60),

          callback_data:
            `person:${String(
              person.id
            )}`
        }
      ];
    });

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
    `🔎 ${results.length} ئەنجام دۆزرایەوە.\n\nیەکێکیان هەڵبژێرە:`,
    buttons
  );
}


/* =========================
   گەڕانی ژمارەی تەلەفون
   ========================= */

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
            `person:${String(
              person.id
            )}`
        }
      ];
    });

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
    `📱 ${results.length} ئەنجام دۆزرایەوە.\n\nیەکێکیان هەڵبژێرە:`,
    buttons
  );
}


/* =========================
   پیشاندانی داتا
   ========================= */

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


/* =========================
   هەموو داتا
   ========================= */

async function getPeople(env) {
  const result =
    await env.DB
      .prepare(`
        SELECT
          id,
          name,
          phone,
          more
        FROM people
        LIMIT 10000
      `)
      .all();

  return (
    result.results || []
  );
}


/* =========================
   کەسێکی دیاریکراو
   ========================= */

async function getPerson(
  env,
  id
) {
  const target =
    String(id ?? "").trim();

  if (!target) {
    return null;
  }

  try {
    const result =
      await env.DB
        .prepare(`
          SELECT
            id,
            name,
            phone,
            more
          FROM people
          WHERE id = ?
             OR TRIM(id) = TRIM(?)
          LIMIT 1
        `)
        .bind(
          target,
          target
        )
        .first();

    if (result) {
      return result;
    }
  } catch (error) {
    console.error(
      "GET PERSON SQL ERROR:",
      error
    );
  }

  try {
    const people =
      await getPeople(env);

    const found =
      people.find(person => {
        const personId =
          String(
            person.id ?? ""
          ).trim();

        return (
          personId === target
        );
      });

    return found || null;

  } catch (error) {
    console.error(
      "GET PERSON FALLBACK ERROR:",
      error
    );

    return null;
  }
}


/* =========================
   ساڵی لەدایکبوون
   ========================= */

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


/* =========================
   پاککردنەوەی زانیاری زیاتر
   ========================= */

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


/* =========================
   مێنی سەرەکی
   ========================= */

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


/* =========================
   ناردنی پەیام
   ========================= */

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

      body:
        JSON.stringify({
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


/* =========================
   پەیام لەگەڵ دوگمە
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
        "content-type":
          "application/json"
      },

      body:
        JSON.stringify({
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


/* =========================
   Callback
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
        "content-type":
          "application/json"
      },

      body:
        JSON.stringify({
          callback_query_id:
            callbackId,

          text,

          show_alert:
            false
        })
    }
  );
}


/* =========================
   Mode
   ========================= */

async function setMode(
  env,
  chatId,
  mode
) {
  await env.DB
    .prepare(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        chat_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'menu'
      )
    `)
    .run();

  await env.DB
    .prepare(`
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
  await env.DB
    .prepare(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        chat_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'menu'
      )
    `)
    .run();

  const row =
    await env.DB
      .prepare(`
        SELECT mode
        FROM bot_sessions
        WHERE chat_id = ?
      `)
      .bind(
        String(chatId)
      )
      .first();

  return (
    row?.mode ||
    "menu"
  );
}


/* =========================
   Normalize ـی ناو
   ========================= */

function normalizeName(value) {
  return String(
    value || ""
  )
    .toLowerCase()

    /*
     * Unicode normalization
     */
    .normalize("NFKC")

    /*
     * لابردنی حەرەکات
     */
    .replace(
      /[ًٌٍَُِّْـ]/g,
      ""
    )

    /*
     * جیاوازی پیتی ی
     */
    .replace(
      /[يىئ]/g,
      "ی"
    )

    /*
     * ک
     */
    .replace(
      /ك/g,
      "ک"
    )

    /*
     * ە
     */
    .replace(
      /[ۀة]/g,
      "ە"
    )

    /*
     * ۆ
     */
    .replace(
      /ؤ/g,
      "ۆ"
    )

    /*
     * ا
     */
    .replace(
      /[أإآ]/g,
      "ا"
    )

    /*
     * نیشانەکانی نێوان وشەکان
     */
    .replace(
      /[،,؛;|/\\()[\]{}:_"'`]/g,
      " "
    )

    /*
     * بۆشایی زیاتر
     */
    .replace(
      /\s+/g,
      " "
    )

    .trim();
}


/* =========================
   Normalize ـی ژمارە
   ========================= */

function normalizePhone(value) {
  return String(
    value || ""
  ).replace(
    /[^\d+]/g,
    ""
  );
}
