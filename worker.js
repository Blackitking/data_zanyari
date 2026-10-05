const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://blackitking.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Import-Key",
  "Access-Control-Max-Age": "86400"
};

function corsResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    // =========================
    // IMPORT DATA TO D1
    // =========================
    if (url.pathname === "/api/import" && request.method === "POST") {
      try {
        const key = request.headers.get("X-Import-Key");

        if (!env.IMPORT_KEY || key !== env.IMPORT_KEY) {
          return corsResponse("Unauthorized", 401);
        }

        const body = await request.json();
        const people = body.people;

        if (!Array.isArray(people)) {
          return corsResponse(
            JSON.stringify({
              ok: false,
              error: "people must be an array"
            }),
            400,
            {
              "Content-Type": "application/json"
            }
          );
        }

        let count = 0;

        for (let i = 0; i < people.length; i += 50) {
          const chunk = people.slice(i, i + 50);

          const statements = chunk.map((person) => {
            const id = String(
              person.id || crypto.randomUUID()
            );

            const name = String(person.name || "");
            const phone = String(person.phone || "");
            const more = String(person.more || "");

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

          await env.DB.batch(statements);
          count += chunk.length;
        }

        return corsResponse(
          JSON.stringify({
            ok: true,
            imported: count
          }),
          200,
          {
            "Content-Type": "application/json"
          }
        );

      } catch (error) {
        console.error("IMPORT ERROR:", error);

        return corsResponse(
          JSON.stringify({
            ok: false,
            error: String(error)
          }),
          500,
          {
            "Content-Type": "application/json"
          }
        );
      }
    }

    // =========================
    // TELEGRAM WEBHOOK
    // =========================
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

    // =========================
    // WORKER TEST
    // =========================
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


// ========================================
// TELEGRAM
// ========================================

async function handleTelegram(update, env) {
  const message = update.message;

  if (!message || !message.text) {
    return;
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  // Only admin
  if (String(chatId) !== String(env.ADMIN_ID)) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "ببورە، ئەم بۆتە تەنها بۆ بەکارهێنانی ڕێگەپێدراوە."
    );

    return;
  }

  // /start
  if (text === "/start") {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "بەخێربێیت 👋\n\nناوی دوانی/سیانی یان ژمارەی تەلەفون بنووسە بۆ گەڕان."
    );

    return;
  }

  // /count
  if (text === "/count") {
    try {
      const result = await env.DB
        .prepare("SELECT COUNT(*) AS count FROM people")
        .first();

      await sendMessage(
        env.BOT_TOKEN,
        chatId,
        `📊 کۆی داتا: ${result?.count || 0}`
      );

    } catch (error) {
      await sendMessage(
        env.BOT_TOKEN,
        chatId,
        "❌ کێشەی D1 هەیە:\n" + String(error)
      );
    }

    return;
  }

  // =========================
  // PHONE SEARCH
  // =========================

  const isPhone = /^[+\d\s()-]+$/.test(text);

  try {
    let results = [];

    if (isPhone) {
      const searchPhone = normalizePhone(text);

      // هەموو داتا بخوێنەوە بۆ ئەوەی
      // ژمارەی بە شێوەی جیاواز نووسراو بدۆزرێتەوە
      const result = await env.DB.prepare(`
        SELECT id, name, phone, more
        FROM people
        LIMIT 10000
      `).all();

      results = (result.results || [])
        .filter((person) => {
          const dbPhone = normalizePhone(person.phone);

          return dbPhone.includes(searchPhone);
        })
        .slice(0, 20);

    } else {

      // =========================
      // NAME SEARCH
      // =========================

      const words = normalizeName(text)
        .split(/\s+/)
        .filter(Boolean);

      if (words.length < 2) {
        await sendMessage(
          env.BOT_TOKEN,
          chatId,
          "تکایە ناوی دوانی یان سیانی بنووسە."
        );

        return;
      }

      const result = await env.DB.prepare(`
        SELECT id, name, phone, more
        FROM people
        LIMIT 10000
      `).all();

      results = (result.results || [])
        .filter((person) => {

          const nameWords = normalizeName(person.name)
            .split(/\s+/)
            .filter(Boolean);

          // هەر وشەی گەڕان دەبێت
          // لە سەرەتای یەکێک لە وشەکانی ناو دەست پێ بکات
          return words.every((searchWord) =>
            nameWords.some((nameWord) =>
              nameWord.startsWith(searchWord)
            )
          );
        })
        .slice(0, 20);
    }

    // =========================
    // NO RESULT
    // =========================

    if (!results.length) {
      await sendMessage(
        env.BOT_TOKEN,
        chatId,
        "❌ هیچ داتایەک نەدۆزرایەوە."
      );

      return;
    }

    // =========================
    // RESULTS
    // =========================

    let output =
      `🔎 ئەنجامەکان: ${results.length}\n\n`;

    for (const person of results) {

      output += `👤 ناو: ${person.name || "-"}\n`;
      output += `📱 تەلەفون: ${person.phone || "-"}`;

      if (person.more) {
        output += `\n📝 زانیاری زیاتر: ${person.more}`;
      }

      output += "\n\n";
    }

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      output
    );

  } catch (error) {

    console.error("SEARCH ERROR:", error);

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "❌ هەڵەیەک ڕوویدا لە گەڕان:\n\n" +
      String(error)
    );
  }
}


// ========================================
// SEND TELEGRAM MESSAGE
// ========================================

async function sendMessage(token, chatId, text) {
  await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000)
      })
    }
  );
}


// ========================================
// NORMALIZE NAME
// ========================================

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/[ۀة]/g, "ە")
    .replace(/\s+/g, " ")
    .trim();
}


// ========================================
// NORMALIZE PHONE
// ========================================

function normalizePhone(value) {
  return String(value || "")
    .replace(/[^\d+]/g, "");
}
