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
       ADMIN_ID
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
       هەموو داتا دەخەینە ناو فایلێکی TXT
       بۆ ئەوەی تەنها یەک داواکاری بۆ Telegram بکرێت.
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
       دروستکردنی فایل TXT
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
       FormData بۆ Telegram
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
       تەنها یەک Request بۆ Telegram
       ئەمە کێشەی Too many subrequests چارەسەر دەکات.
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
