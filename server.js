const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

let highlights = [
    {
        id: 1,
        title: "1v4 Clean Turf Clutch - Rio",
        url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
        author: "Rio",
        date: "2026-10-16"
    }
];

let leaderboard = [
    { rank: 1, name: "Rio Rebel", kills: 1420, deaths: 310, kd: 4.58 },
    { rank: 2, name: "Lee Apex", kills: 1280, deaths: 350, kd: 3.65 },
    { rank: 3, name: "Zwox", kills: 1150, deaths: 410, kd: 2.80 },
    { rank: 4, name: "Ghost", kills: 980, deaths: 390, kd: 2.51 },
    { rank: 5, name: "Viper", kills: 890, deaths: 400, kd: 2.22 }
];

let turfData = {
    dominance: "100%",
    gangName: "Families (Rebel FamQ)",
    leader: "Rio Rebel",
    territory: "Los Santos Entire Turf / South Central",
    image: "pictures/serverbanner.png"
};

app.get('/api/highlights', (req, res) => { res.json(highlights); });
app.get('/api/leaderboard', (req, res) => { res.json(leaderboard); });
app.get('/api/turf', (req, res) => { res.json(turfData); });

// Highlight Ekleme (Rio Şifre: zwoxcan99)
app.post('/api/highlights', (req, res) => {
    const { username, password, title, url } = req.body;
    if (username !== 'Rio' || password !== 'zwoxcan99') {
        return res.status(401).json({ error: "Yetkisiz erişim! Yanlış şifre." });
    }
    if (!title || !url) return res.status(400).json({ error: "Alanlar boş bırakılamaz!" });

    let embedUrl = url;
    if (url.includes("watch?v=")) embedUrl = url.replace("watch?v=", "embed/");
    else if (url.includes("youtu.be/")) embedUrl = url.replace("youtu.be/", "www.youtube.com/embed/");

    const newHighlight = {
        id: Date.now(),
        title,
        url: embedUrl,
        author: "Rio",
        date: new Date().toISOString().split('T')[0]
    };
    highlights.unshift(newHighlight);
    res.json({ success: true, highlight: newHighlight });
});

// Highlight Silme API (Rio Şifre: zwoxcan99)
app.post('/api/highlights/delete', (req, res) => {
    const { username, password, id } = req.body;
    if (username !== 'Rio' || password !== 'zwoxcan99') {
        return res.status(401).json({ error: "Yetkisiz erişim! Yanlış şifre." });
    }

    highlights = highlights.filter(item => item.id !== id);
    res.json({ success: true, highlights });
});

// Leaderboard Güncelleme (Rio Şifre: zwoxcan99)
app.post('/api/leaderboard', (req, res) => {
    const { username, password, newLeaderboard } = req.body;
    if (username !== 'Rio' || password !== 'zwoxcan99') {
        return res.status(401).json({ error: "Yetkisiz erişim! Yanlış şifre." });
    }
    if (!Array.isArray(newLeaderboard)) {
        return res.status(400).json({ error: "Geçersiz veri formatı!" });
    }

    leaderboard = newLeaderboard;
    res.json({ success: true, leaderboard });
});

// Turf Güncelleme (Rio Şifre: zwoxcan99)
app.post('/api/turf', (req, res) => {
    const { username, password, gangName, leader, territory } = req.body;
    if (username !== 'Rio' || password !== 'zwoxcan99') {
        return res.status(401).json({ error: "Yetkisiz erişim! Yanlış şifre." });
    }
    if (gangName) turfData.gangName = gangName;
    if (leader) turfData.leader = leader;
    if (territory) turfData.territory = territory;
    res.json({ success: true, turfData });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Rebel PvP Website running on port ${PORT}`);
});
