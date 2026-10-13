const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// HTML ve statik dosyaları sun
app.use(express.static(__joinname || __dirname));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Site ${PORT} portunda aktif!`);
});