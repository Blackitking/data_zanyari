const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const DB_FILE = path.join(__dirname, "db.json");

function loadPeople() {
    if (!fs.existsSync(DB_FILE)) {
        return [];
    }

    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function savePeople(people) {
    fs.writeFileSync(
        DB_FILE,
        JSON.stringify(people, null, 2),
        "utf8"
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

// گەڕانی ناو
app.get("/api/search/name", (req, res) => {
    const q = String(req.query.q || "").trim();

    const words = normalizeName(q).split(/\s+/).filter(Boolean);

    if (words.length < 2) {
        return res.json({
            ok: false,
            message: "تکایە ناوی دوانی یان سیانی بنووسە.",
            results: []
        });
    }

    const people = loadPeople();

    const results = people.filter(person => {
        const nameWords = normalizeName(person.name)
            .split(/\s+/)
            .filter(Boolean);

        return words.every(word =>
            nameWords.some(nameWord =>
                nameWord.startsWith(word)
            )
        );
    });

    res.json({
        ok: true,
        results
    });
});

// گەڕانی ژمارە
app.get("/api/search/phone", (req, res) => {
    const q = normalizePhone(req.query.q || "");

    if (!q) {
        return res.json({
            ok: true,
            results: []
        });
    }

    const people = loadPeople();

    const results = people.filter(person =>
        normalizePhone(person.phone).includes(q)
    );

    res.json({
        ok: true,
        results
    });
});

// زیادکردنی کەس
app.post("/api/admin/add", (req, res) => {
    const { name = "", phone = "", more = "" } = req.body;

    const cleanName = String(name).trim();
    const cleanPhone = String(phone).trim();
    const cleanMore = String(more).trim();

    if (!cleanName && !cleanPhone) {
        return res.status(400).json({
            ok: false,
            message: "تکایە ناو یان ژمارەی تەلەفون بنووسە."
        });
    }

    const people = loadPeople();

    const normalizedNewName = normalizeName(cleanName);

    if (normalizedNewName) {
        const duplicateName = people.some(person =>
            normalizeName(person.name) === normalizedNewName
        );

        if (duplicateName) {
            return res.status(409).json({
                ok: false,
                message: "ببورە، ئەم ناوە دوبارەیە."
            });
        }
    }

    const normalizedNewPhone = normalizePhone(cleanPhone);

    if (normalizedNewPhone) {
        const duplicatePhone = people.some(person =>
            normalizePhone(person.phone) === normalizedNewPhone
        );

        if (duplicatePhone) {
            return res.status(409).json({
                ok: false,
                message: "ببورە، ئەم ژمارەی تەلەفونە دوبارەیە."
            });
        }
    }

    const person = {
        id: Date.now().toString(),
        name: cleanName,
        phone: cleanPhone,
        more: cleanMore
    };

    people.push(person);
    savePeople(people);

    res.json({
        ok: true,
        person
    });
});

// هەموو داتا
app.get("/api/admin/people", (req, res) => {
    res.json({
        ok: true,
        results: loadPeople()
    });
});

// سڕینەوەی کەس
app.delete("/api/admin/people/:id", (req, res) => {
    const people = loadPeople();

    const newPeople = people.filter(
        person => String(person.id) !== String(req.params.id)
    );

    if (newPeople.length === people.length) {
        return res.status(404).json({
            ok: false,
            message: "کەسەکە نەدۆزرایەوە."
        });
    }

    savePeople(newPeople);

    res.json({
        ok: true
    });
});

// Health check
app.get("/", (req, res) => {
    res.send("Data Zanyari API is running.");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
