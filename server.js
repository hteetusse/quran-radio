const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const AUDIO_DIR = path.join(__dirname, 'audio');
const QURAN_CDN_URL = 'https://cdn.jsdelivr.net/npm/quran-json@3.1.2/dist/quran.json';

let serverQuranData = [];
let currentSurahIndex = 0;
let currentVerseIndex = 0;
let clients = [];
let nowPlayingInfo = { surahName: 'Initializing...', verseText: '...', verseNumber: 0, type: 'loading', surahId: 0, verseIndexInSurah: 0 };
let isStreaming = false;
let loopCount = 0;

function getAudioPath(filename) {
    return path.join(AUDIO_DIR, path.basename(filename));
}

function processJsonDataForServer(jsonData) {
    return jsonData.map(surah => {
        let versesWithAudio = [];
        if (surah.id === 1) {
            versesWithAudio.push({ audio: `/audio/001000.mp3`, type: 'aoudhu', text: "أَعُوذُ بِٱللَّهِ مِنَ ٱلشَّيْطَٰنِ ٱلرَّجِيمِ", number: 0 });
        }
        if (surah.id !== 9) {
            versesWithAudio.push({ audio: surah.id === 1 ? `/audio/001001.mp3` : `/audio/${String(surah.id).padStart(3, '0')}000.mp3`, type: 'bismillah', text: "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ", number: 0 });
        }
        surah.verses.forEach((v, i) => {
            const verseNumber = i + 1;
            const audioFileName = `${String(surah.id).padStart(3, '0')}${String(verseNumber).padStart(3, '0')}.mp3`;
            versesWithAudio.push({ audio: `/audio/${audioFileName}`, type: 'verse', text: v.text, number: verseNumber });
        });
        return {
            id: surah.id,
            name: surah.name,
            verses: versesWithAudio
        };
    });
}

async function loadQuranDataFromCDN() {
    console.log(`Fetching Quran data from ${QURAN_CDN_URL}...`);
    return new Promise((resolve, reject) => {
        https.get(QURAN_CDN_URL, (res) => {
            let rawData = '';
            if (res.statusCode !== 200) return reject(new Error(`Failed to fetch: ${res.statusCode}`));
            res.setEncoding('utf8');
            res.on('data', chunk => rawData += chunk);
            res.on('end', () => {
                try {
                    serverQuranData = processJsonDataForServer(JSON.parse(rawData));
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

function streamNextVerse() {
    if (!serverQuranData.length) return;
    const surah = serverQuranData[currentSurahIndex];
    if (!surah || !surah.verses.length) return advanceToNextVerse(true), streamNextVerse();
    if (currentVerseIndex >= surah.verses.length) return advanceToNextVerse(true), streamNextVerse();

    const verse = surah.verses[currentVerseIndex];
    const audioFilePath = getAudioPath(verse.audio);
    nowPlayingInfo = {
        surahName: surah.name,
        verseText: verse.text,
        verseNumber: verse.number,
        type: verse.type,
        surahId: surah.id,
        verseIndexInSurah: currentVerseIndex,
        loop: loopCount
    };

    fs.access(audioFilePath, fs.constants.R_OK, err => {
        if (err) return advanceToNextVerse(), streamNextVerse();
        const fileStream = fs.createReadStream(audioFilePath);
        let activeStream = true;

        const pipeChunk = chunk => {
            const bufferCopy = Buffer.from(chunk);
            clients.forEach(clientRes => {
                if (!clientRes.writableEnded) {
                    clientRes.write(bufferCopy, err => {
                        if (err) {
                            clients = clients.filter(c => c !== clientRes);
                            try { clientRes.end(); } catch (_) {}
                        }
                    });
                }
            });
        };

        fileStream.on('data', chunk => activeStream && pipeChunk(chunk));
        fileStream.on('end', () => { if (activeStream) advanceToNextVerse(); streamNextVerse(); });
        fileStream.on('error', () => { advanceToNextVerse(); streamNextVerse(); });
    });
}

function advanceToNextVerse(force = false) {
    if (!serverQuranData.length) return;
    const currentSurah = serverQuranData[currentSurahIndex];
    currentVerseIndex++;
    if (currentVerseIndex >= currentSurah.verses.length) {
        currentVerseIndex = 0;
        currentSurahIndex++;
        if (currentSurahIndex >= serverQuranData.length) {
            currentSurahIndex = 0;
            loopCount++;
        }
    }
}

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Quran Radio is running.');
    } else if (req.url === '/stream') {
        if (!serverQuranData.length) return res.writeHead(503).end('Service Unavailable');
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache'
        });
        clients.push(res);
        if (!isStreaming) {
            isStreaming = true;
            streamNextVerse();
        }
        req.on('close', () => clients = clients.filter(c => c !== res));
    } else if (req.url === '/now-playing') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nowPlayingInfo));
    } else {
        res.writeHead(404).end('Not Found');
    }
});

async function startServer() {
    try {
        await loadQuranDataFromCDN();
        server.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
        });
    } catch (e) {
        console.error('Error starting server:', e);
    }
}

startServer();
