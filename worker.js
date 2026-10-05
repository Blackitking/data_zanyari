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

        const update = await request.json();

        await handleTelegram(update, env);

        return new Response(
          "OK",
          {
            status: 200,
            headers: CORS_HEADERS
          }
        );

      } catch (error) {

        console.error("TELEGRAM ERROR:", error);

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
        "Content-Type": "application/json; charset=utf-8"
      }
    );

  }

};


/* =====================================================
   WEBSITE NAME SEARCH API
   ===================================================== */

async function searchNameAPI(request, env) {

  try {

    const url = new URL(request.url);

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

          if (name.includes(search)) {
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

    console.error("NAME API ERROR:", error);

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

    const url = new URL(request.url);

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
        .filter(person =>
          normalizePhone(person.phone)
            .includes(phone)
        )
        .slice(0, 50);

    return json({
      ok: true,
      people: results,
      count: results.length
    });

  } catch (error) {

    console.error("PHONE API ERROR:", error);

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
            String(person.name || "");

          const phone =
            String(person.phone || "");

          const more =
            String(person.more || "");

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

      await env.DB.batch(statements);

    }

    return json({
      ok: true,
      imported: people.length
    });

  } catch (error) {

    console.error("IMPORT ERROR:", error);

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

async function telegramExport(request, env) {

  try {

    if (!env.BOT_TOKEN) {

      return json(
        {
          ok: false,
          error: "BOT_TOKEN is not configured"
        },
        500
      );

    }

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

    const file =
      new Blob(
        [text],
        {
          type: "text/plain; charset=utf-8"
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
      `📦 هەموو داتا\n📊 کۆی تۆمارەکان: ${people.length}`
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
      exported: people.length,
      type: "txt"
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

  /*
     هیچ ADMIN_ID ـێک لێرە نییە.
     هەموو بەکارهێنەران دەتوانن بۆتەکە بەکاربهێنن.
  */

  if (text === "/start") {

    await setMode(
      env,
      chatId,
      "menu"
    );
