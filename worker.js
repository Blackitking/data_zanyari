بەڵێ کاکە گیان، ئێستا کۆدەکەت بینی. کێشەکە بەڕاستی CORS ـە؛ چونکە index.html ـەکەت لە GitHub Pages ـە و دەیەوێت بۆ Cloudflare Worker داواکاری بنێرێت.
من کۆدەکەت بە شێوەیەک چاک دەکەم کە:
Telegram ـەکەت هەروا کار بکات.
/api/import هەروا IMPORT_KEY بخوازێت.
GitHub Pages بتوانێت پەیوەندی بە Worker بکات.
OPTIONS ـی CORS وەڵام بدرێتەوە.
هیچ گۆڕانکارییەک لە D1/Telegram ـەکەت نەکرێت.
ئەم worker.js ـە بە تەواوی جێگای کۆدەکەی ئێستات دابنێ:
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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    // گواستنەوەی داتاکانی localStorage بۆ D1
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
            { "Content-Type": "application/json" }
          );
        }

        let count = 0;

        for (let i = 0; i < people.length; i += 50) {
          const chunk = people.slice(i, i + 50);

          const statements = chunk.map((person) => {
            const id = String(
              person.id || crypto.randomUUID()
            );

            const name = String(
              person.name || ""
            );

            const phone = String(
              person.phone || ""
            );

            const more = String(
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
        console.error("Import error:", error);

        return corsResponse(
          JSON.stringify({
            ok: false,
            error: "Import failed"
          }),
          500,
          {
            "Content-Type": "application/json"
          }
        );
      }
    }

    // Telegram webhook
    if (
      url.pathname === "/telegram/webhook" &&
      request.method === "POST"
    ) {
      const update = await request.json();

      await handleTelegram(update, env);

      return new Response("OK");
    }

    // Health check
    if (url.pathname === "/") {
      return new Response(
        "Data Zanyari Worker is running."
      );
    }

    return new Response(
      "Not Found",
      { status: 404 }
    );
  }
};


async function handleTelegram(update, env) {
  const message = update.message;

  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  // تەنها خاوەنی بۆتەکە
  if (String(chatId) !== String(env.ADMIN_ID)) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "ببورە، ئەم بۆتە تەنها بۆ بەکارهێنانی ڕێگەپێدراوە."
    );

    return;
  }

  if (text === "/start") {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "بەخێربێیت 👋\n\nناوی دوانی/سیانی یان ژمارەی تەلەفون بنووسە بۆ گەڕان."
    );

    return;
  }

  const isPhone =
    /^[+\d\s()-]+$/.test(text);

  let results;

  if (isPhone) {

    const phone =
      normalizePhone(text);

    const result =
      await env.DB.prepare(`
        SELECT id, name, phone, more
        FROM people
        WHERE phone LIKE ?
        LIMIT 50
      `)
      .bind(`%${phone}%`)
      .all();

    results =
      result.results || [];

  } else {

    const words =
      normalizeName(text)
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

    const result =
      await env.DB.prepare(`
        SELECT id, name, phone, more
        FROM people
        LIMIT 500
      `)
      .all();

    results =
      (result.results || [])
        .filter(person => {

          const nameWords =
            normalizeName(person.name)
              .split(/\s+/)
              .filter(Boolean);

          return words.every(word =>
            nameWords.some(
              nameWord =>
                nameWord.startsWith(word)
            )
          );

        })
        .slice(0, 50);
  }

  if (!results.length) {

    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "هیچ داتایەک نەدۆزرایەوە."
    );

    return;
  }

  let output =
    `🔎 ئەنجامەکان: ${results.length}\n\n`;

  for (const person of results) {

    output +=
      `👤 ${person.name || "-"}\n`;

    output +=
      `📱 ${person.phone || "-"}\n`;

    if (person.more) {
      output +=
        `📝 ${person.more}\n`;
    }

    output += "\n";
  }

  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    output
  );
}


async function sendMessage(
  token,
  chatId,
  text
) {
  await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",

      headers: {
        "content-type": "application/json"
      },

      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    }
  );
}


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


function normalizePhone(value) {
  return String(value || "")
    .replace(/[^\d+]/g, "");
}
دوای ئەوە
لە Cloudflare Worker ـەکەت:
Edit code → هەموو کۆدی worker.js بسڕەوە → ئەم کۆدە Paste بکە → Save and deploy
پاشان index.html ـەکەت کە ناردووتە لەگەڵ ئەم Worker ـە گونجاوە.
IMPORT_KEY ـەکەت ناگۆڕیت.
BOT_TOKEN و ADMIN_ID ـیش ناگۆڕیت.
D1 ـیش ناگۆڕیت.
پاش Deploy، دەتوانین یەکەم جار گواستنەوەی داتا لە localStorage بۆ D1 تاقی بکەینەوە.
