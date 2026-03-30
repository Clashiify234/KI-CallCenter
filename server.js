require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

const API_KEYS = {
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    elevenlabs: process.env.ELEVENLABS_API_KEY || ''
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============ Knowledge Base (in-memory for now) ============
let knowledgeBase = [];
const KB_FILE = path.join(__dirname, 'knowledge-base.json');

function loadKB() {
    try {
        if (fs.existsSync(KB_FILE)) {
            knowledgeBase = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
        }
    } catch (e) {
        knowledgeBase = [];
    }
}
function saveKB() {
    fs.writeFileSync(KB_FILE, JSON.stringify(knowledgeBase, null, 2));
}
loadKB();

// ============ Tickets (in-memory for now) ============
let tickets = [];
const TICKETS_FILE = path.join(__dirname, 'tickets.json');

function loadTickets() {
    try {
        if (fs.existsSync(TICKETS_FILE)) {
            tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));
        }
    } catch (e) {
        tickets = [];
    }
}
function saveTickets() {
    fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
}
loadTickets();

// ============ API Routes ============

// Chat with Claude (Contact Center Agent)
app.post('/api/chat', async (req, res) => {
    const { message, history = [], channel = 'chat' } = req.body;

    if (!API_KEYS.anthropic) {
        return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    const kbContext = knowledgeBase.length > 0
        ? '\n\nKnowledge Base:\n' + knowledgeBase.map(k => `- ${k.question}: ${k.answer}`).join('\n')
        : '';

    const systemPrompt = `Du bist ein freundlicher und kompetenter KI-Service-Agent eines Contact Centers. Du sprichst Deutsch, bist lösungsorientiert und fasst dich kurz (2-3 Sätze pro Antwort).

Regeln:
- Nutze die Knowledge Base, um Fragen zu beantworten
- Wenn du die Antwort nicht sicher weißt, sag das ehrlich und biete Eskalation an einen menschlichen Kollegen an
- Erfinde niemals Informationen
- Sei empathisch bei Beschwerden
- Erfasse immer den Kontaktgrund${kbContext}`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEYS.anthropic,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: systemPrompt,
                messages: [
                    ...history.map(h => ({ role: h.role, content: h.content })),
                    { role: 'user', content: message }
                ]
            })
        });

        const data = await response.json();
        if (data.error) {
            return res.status(500).json({ error: data.error.message });
        }

        const reply = data.content[0].text;

        // Auto-create ticket
        const ticketId = `T-${String(tickets.length + 1).padStart(4, '0')}`;
        const ticket = {
            id: ticketId,
            channel,
            date: new Date().toISOString(),
            message,
            reply,
            status: 'resolved',
            intent: 'auto-detected'
        };
        tickets.push(ticket);
        saveTickets();

        res.json({ reply, ticketId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Knowledge Base CRUD
app.get('/api/kb', (req, res) => {
    res.json(knowledgeBase);
});

app.post('/api/kb', (req, res) => {
    const { question, answer, category } = req.body;
    const entry = {
        id: Date.now().toString(),
        question,
        answer,
        category: category || 'Allgemein',
        created: new Date().toISOString()
    };
    knowledgeBase.push(entry);
    saveKB();
    res.json(entry);
});

app.delete('/api/kb/:id', (req, res) => {
    knowledgeBase = knowledgeBase.filter(k => k.id !== req.params.id);
    saveKB();
    res.json({ success: true });
});

// Tickets
app.get('/api/tickets', (req, res) => {
    res.json(tickets);
});

app.patch('/api/tickets/:id', (req, res) => {
    const ticket = tickets.find(t => t.id === req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    Object.assign(ticket, req.body);
    saveTickets();
    res.json(ticket);
});

// Dashboard Stats
app.get('/api/stats', (req, res) => {
    const total = tickets.length;
    const resolved = tickets.filter(t => t.status === 'resolved').length;
    const escalated = tickets.filter(t => t.status === 'escalated').length;
    const open = tickets.filter(t => t.status === 'open').length;
    const today = new Date().toISOString().split('T')[0];
    const todayCount = tickets.filter(t => t.date.startsWith(today)).length;

    res.json({
        total,
        resolved,
        escalated,
        open,
        todayCount,
        fcr: total > 0 ? Math.round((resolved / total) * 100) : 0,
        channels: {
            chat: tickets.filter(t => t.channel === 'chat').length,
            voice: tickets.filter(t => t.channel === 'voice').length,
            email: tickets.filter(t => t.channel === 'email').length
        }
    });
});

// ============ Streaming Chat with Claude ============
app.post('/api/chat/stream', async (req, res) => {
    const { message, history = [], channel = 'voice' } = req.body;

    if (!API_KEYS.anthropic) {
        return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    const kbContext = knowledgeBase.length > 0
        ? '\n\nKnowledge Base:\n' + knowledgeBase.map(k => `- ${k.question}: ${k.answer}`).join('\n')
        : '';

    const systemPrompt = `Du bist ein freundlicher und kompetenter KI-Service-Agent eines Contact Centers am Telefon. Du sprichst Deutsch, bist lösungsorientiert und fasst dich kurz (2-3 Sätze pro Antwort).

Regeln:
- Nutze die Knowledge Base, um Fragen zu beantworten
- Wenn du die Antwort nicht sicher weißt, sag das ehrlich und biete Eskalation an einen menschlichen Kollegen an
- Erfinde niemals Informationen
- Sei empathisch bei Beschwerden
- Antworte natürlich und gesprächig, wie am Telefon — keine Markdown-Formatierung, keine Aufzählungen
- Erfasse immer den Kontaktgrund${kbContext}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEYS.anthropic,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 512,
                stream: true,
                system: systemPrompt,
                messages: [
                    ...history.map(h => ({ role: h.role, content: h.content })),
                    { role: 'user', content: message }
                ]
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            res.write(`data: ${JSON.stringify({ error: err.error?.message || 'Claude error' })}\n\n`);
            res.end();
            return;
        }

        let fullReply = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                        const chunk = parsed.delta.text;
                        fullReply += chunk;
                        res.write(`data: ${JSON.stringify({ chunk, full: fullReply })}\n\n`);
                    }
                } catch (e) {}
            }
        }

        // Create ticket
        const ticketId = `T-${String(tickets.length + 1).padStart(4, '0')}`;
        tickets.push({
            id: ticketId, channel, date: new Date().toISOString(),
            message, reply: fullReply, status: 'resolved', intent: 'auto-detected'
        });
        saveTickets();

        res.write(`data: ${JSON.stringify({ done: true, ticketId, full: fullReply })}\n\n`);
        res.end();
    } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    }
});

// ============ ElevenLabs TTS ============
const elevenlabsCache = new Map();

app.post('/api/tts-elevenlabs', async (req, res) => {
    try {
        const { text } = req.body;
        console.log('[ElevenLabs] Request received, text length:', text ? text.length : 0);
        if (!text || text.trim() === '') return res.status(400).json({ error: 'No text' });

        const apiKey = API_KEYS.elevenlabs;
        const voiceId = 'ztZBipzb4WQJRDayep3G';
        console.log('[ElevenLabs] API key present:', !!apiKey, '| Voice ID:', voiceId);
        if (!apiKey) {
            console.error('[ElevenLabs] No API key configured!');
            return res.status(500).json({ error: 'ElevenLabs API key not configured' });
        }

        // Check cache
        const cacheKey = voiceId + ':' + text;
        if (elevenlabsCache.has(cacheKey)) {
            const cached = elevenlabsCache.get(cacheKey);
            console.log('[ElevenLabs] Cache hit, sending', cached.length, 'bytes');
            res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': cached.length });
            return res.send(cached);
        }

        const apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
        console.log('[ElevenLabs] Calling API:', apiUrl);

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true,
                    speed: 0.85
                }
            })
        });

        console.log('[ElevenLabs] API response:', response.status, response.statusText);

        if (!response.ok) {
            const errText = await response.text();
            console.error('[ElevenLabs] API error:', response.status, errText);
            return res.status(response.status).json({ error: 'ElevenLabs failed: ' + errText });
        }

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuffer);
        console.log('[ElevenLabs] Audio received:', audioBuffer.length, 'bytes');

        // Cache (max 50 entries)
        if (elevenlabsCache.size >= 50) elevenlabsCache.delete(elevenlabsCache.keys().next().value);
        elevenlabsCache.set(cacheKey, audioBuffer);

        res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.length });
        res.send(audioBuffer);
    } catch (err) {
        console.error('[ElevenLabs] TTS error:', err.message, err.stack);
        res.status(500).json({ error: 'ElevenLabs TTS failed: ' + err.message });
    }
});

console.log('  ElevenLabs TTS loaded ✓');

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
    console.log(`KI-CallCenter running on http://localhost:${PORT}`);
});
