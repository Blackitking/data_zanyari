const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
require("dotenv").config();

const token = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL;

if (!token) {
    console.error("BOT_TOKEN نەدۆزرایەوە.");
    process.exit(1);
}

if (!API_URL) {
    console.error("API_URL نەدۆزرایەوە.");
    process.exit(1);
}

const bot = new TelegramBot(token, {
    polling: true
});

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        "بەخێربێیت 👋\n\nناوی کەسەکە یان ژمارەی تەلەفون بنووسە بۆ گەڕان."
    );
});

bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const query = msg.text.trim();

    try {
        // ئەگەر ژمارەی تەلەفون بێت
        if (/^[+\d\s()-]+$/.test(query)) {
            const response = await axios.get(
                `${API_URL}/api/search/phone`,
                {
                    params: { q: query }
                }
            );

            const results = response.data.results || [];

            if (results.length === 0) {
                return bot.sendMessage(
                    msg.chat.id,
                    "هیچ داتایەک بۆ ئەم ژمارەیە نەدۆزرایەوە."
                );
            }

            return sendResults(msg.chat.id, results);
        }

        // گەڕانی ناو
        const words = query.split(/\s+/).filter(Boolean);

        if (words.length < 2) {
            return bot.sendMessage(
                msg.chat.id,
                "تکایە ناوی دوانی یان سیانی بنووسە."
            );
        }

        const response = await axios.get(
            `${API_URL}/api/search/name`,
            {
                params: { q: query }
            }
        );

        const results = response.data.results || [];

        if (results.length === 0) {
            return bot.sendMessage(
                msg.chat.id,
                "هیچ داتایەک نەدۆزرایەوە."
            );
        }

        sendResults(msg.chat.id, results);

    } catch (error) {
        console.error(error.message);

        bot.sendMessage(
            msg.chat.id,
            "کێشەیەک ڕوویدا، تکایە دواتر هەوڵ بدەرەوە."
        );
    }
});

function sendResults(chatId, results) {
    let text = `🔎 ئەنجامەکان: ${results.length}\n\n`;

    results.forEach((person, index) => {
        text += `${index + 1}) `;

        if (person.name) {
            text += `👤 ${person.name}\n`;
        }

        if (person.phone) {
            text += `📱 ${person.phone}\n`;
        }

        if (person.more) {
            text += `📝 ${person.more}\n`;
        }

        text += "\n";
    });

    return bot.sendMessage(chatId, text);
}

console.log("Telegram Bot started...");
