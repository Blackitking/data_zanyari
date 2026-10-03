export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram webhook
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const update = await request.json();
      await handleTelegram(update, env);
      return new Response("OK");
    }

    // Health check
    if (url.pathname === "/") {
      return new Response("Data Zanyari Worker is running.");
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleTelegram(update, env) {
  const message = update.message;

  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  // تەنها Telegram ID ـی خۆت دەتوانێت داتا بگەڕێتەوە
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

  const isPhone = /^[+\d\s()-]+$/.test(text);

  let results;

  if (isPhone) {
    const phone = normalizePhone(text);

    const result = await env.DB.prepare(`
      SELECT id, name, phone, more
      FROM people
      WHERE phone LIKE ?
      LIMIT 50
    `).bind(`%${phone}%`).all();

    results = result.results || [];
  } else {
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
      LIMIT 500
    `).all();

    results = (result.results || []).filter(person => {
      const nameWords = normalizeName(person.name)
        .split(/\s+/)
        .filter(Boolean);

      return words.every(word =>
        nameWords.some(nameWord => nameWord.startsWith(word))
      );
    }).slice(0, 50);
  }

  if (!results.length) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "هیچ داتایەک نەدۆزرایەوە."
    );
    return;
  }

  let output = `🔎 ئەنجامەکان: ${results.length}\n\n`;

  for (const person of results) {
    output += `👤 ${person.name || "-"}\n`;
    output += `📱 ${person.phone || "-"}\n`;

    if (person.more) {
      output += `📝 ${person.more}\n`;
    }

    output += "\n";
  }

  await sendMessage(env.BOT_TOKEN, chatId, output);
}

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
  return String(value || "").replace(/[^\d+]/g, "");
}
