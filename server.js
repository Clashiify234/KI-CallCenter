require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3001;

const API_KEYS = {
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    elevenlabs: process.env.ELEVENLABS_API_KEY || ''
};

const EMAIL_CONFIG = {
    user: process.env.GMAIL_USER || '',
    pass: process.env.GMAIL_APP_PASSWORD || '',
    imapHost: 'imap.gmail.com',
    smtpHost: 'smtp.gmail.com'
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
        const voiceId = '6CS8keYmkwxkspesdyA7';
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

// ============ Email System ============
let emails = [];
const EMAILS_FILE = path.join(__dirname, 'emails.json');

function loadEmails() {
    try {
        if (fs.existsSync(EMAILS_FILE)) {
            emails = JSON.parse(fs.readFileSync(EMAILS_FILE, 'utf8'));
        }
    } catch (e) { emails = []; }
}
function saveEmails() {
    fs.writeFileSync(EMAILS_FILE, JSON.stringify(emails, null, 2));
}
loadEmails();

// SMTP Transporter (resolve IPv4 manually for Render compatibility)
async function createTransporter() {
    const addresses = await dns.promises.resolve4('smtp.gmail.com');
    const ip = addresses[0];
    console.log('[SMTP] Resolved smtp.gmail.com to IPv4:', ip);
    return nodemailer.createTransport({
        host: ip,
        port: 465,
        secure: true,
        auth: { user: EMAIL_CONFIG.user, pass: EMAIL_CONFIG.pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        tls: { rejectUnauthorized: false, servername: 'smtp.gmail.com' }
    });
}

// Fetch emails via IMAP
function fetchNewEmails() {
    return new Promise((resolve, reject) => {
        if (!EMAIL_CONFIG.user || !EMAIL_CONFIG.pass) {
            return reject(new Error('Gmail credentials not configured'));
        }

        // Resolve IMAP host to IPv4 first
        const net = require('net');
        const imap = new Imap({
            user: EMAIL_CONFIG.user,
            password: EMAIL_CONFIG.pass,
            host: EMAIL_CONFIG.imapHost,
            port: 993,
            tls: true,
            tlsOptions: { rejectUnauthorized: false, family: 4 },
            socketTimeout: 15000,
            connTimeout: 10000
        });

        const results = [];

        imap.once('ready', () => {
            imap.openBox('INBOX', false, (err, box) => {
                if (err) { imap.end(); return reject(err); }

                // Fetch unseen emails from today only
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                imap.search(['UNSEEN', ['SINCE', today]], (err, uids) => {
                    if (err) { imap.end(); return reject(err); }
                    if (!uids || uids.length === 0) { imap.end(); return resolve([]); }

                    const f = imap.fetch(uids, { bodies: '', markSeen: true });

                    f.on('message', (msg) => {
                        msg.on('body', (stream) => {
                            simpleParser(stream, (err, parsed) => {
                                if (err) return;
                                results.push({
                                    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
                                    from: parsed.from?.text || 'Unbekannt',
                                    fromAddress: parsed.from?.value?.[0]?.address || '',
                                    subject: parsed.subject || '(Kein Betreff)',
                                    body: parsed.text || parsed.html?.replace(/<[^>]*>/g, '') || '',
                                    date: parsed.date?.toISOString() || new Date().toISOString(),
                                    status: 'new',
                                    reply: null,
                                    repliedAt: null
                                });
                            });
                        });
                    });

                    f.once('end', () => {
                        // Wait a bit for all parsers to finish
                        setTimeout(() => {
                            imap.end();
                            resolve(results);
                        }, 1000);
                    });

                    f.once('error', (err) => {
                        imap.end();
                        reject(err);
                    });
                });
            });
        });

        imap.once('error', (err) => reject(err));
        imap.connect();
    });
}

// GET /api/emails — list all emails
app.get('/api/emails', (req, res) => {
    res.json(emails);
});

// POST /api/emails/fetch — fetch new emails from IMAP
app.post('/api/emails/fetch', async (req, res) => {
    try {
        const newEmails = await fetchNewEmails();
        if (newEmails.length > 0) {
            emails.push(...newEmails);
            saveEmails();
        }
        res.json({ fetched: newEmails.length, total: emails.length });
    } catch (err) {
        console.error('[EMAIL] Fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/emails/analyze — Claude analyzes an email and drafts a reply
app.post('/api/emails/analyze', async (req, res) => {
    const { emailId } = req.body;
    const email = emails.find(e => e.id === emailId);
    if (!email) return res.status(404).json({ error: 'Email not found' });

    const kbContext = knowledgeBase.length > 0
        ? '\n\nKnowledge Base:\n' + knowledgeBase.map(k => `- ${k.question}: ${k.answer}`).join('\n')
        : '';

    const systemPrompt = `Du bist ein professioneller KI-Kundenservice-Agent eines Contact Centers. Du analysierst eingehende Kunden-Emails und verfasst passende, freundliche Antworten auf Deutsch.

Regeln:
- Analysiere die Email: Erkenne den Kontaktgrund (Beschwerde, Frage, Bestellung, Retoure, etc.)
- Extrahiere wichtige Daten (Bestellnummer, Kundennummer, Produktname, etc.)
- Verfasse eine professionelle, empathische Antwort-Email
- Nutze die Knowledge Base falls relevant
- Sei lösungsorientiert
- Erfinde KEINE Informationen — wenn du etwas nicht weißt, sag das ehrlich
- Format: Schreibe NUR die Antwort-Email (mit Anrede und Grußformel), keine Meta-Kommentare${kbContext}`;

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
                messages: [{
                    role: 'user',
                    content: `Eingehende Email:\nVon: ${email.from}\nBetreff: ${email.subject}\n\n${email.body}`
                }]
            })
        });

        const data = await response.json();
        if (data.error) return res.status(500).json({ error: data.error.message });

        const draft = data.content[0].text;

        // Detect intent
        const intentResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEYS.anthropic,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 100,
                messages: [{
                    role: 'user',
                    content: `Klassifiziere diese Kunden-Email in EINEM Wort (z.B. Beschwerde, Frage, Bestellung, Retoure, Stornierung, Lob, Sonstiges):\n\nBetreff: ${email.subject}\n${email.body}`
                }]
            })
        });
        const intentData = await intentResponse.json();
        const intent = intentData.content?.[0]?.text?.trim() || 'Sonstiges';

        email.status = 'analyzed';
        email.draft = draft;
        email.intent = intent;
        saveEmails();

        res.json({ draft, intent, email });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/emails/reply — send the reply via SMTP
app.post('/api/emails/reply', async (req, res) => {
    const { emailId, replyText } = req.body;
    const email = emails.find(e => e.id === emailId);
    if (!email) return res.status(404).json({ error: 'Email not found' });

    if (!EMAIL_CONFIG.user || !EMAIL_CONFIG.pass) {
        return res.status(500).json({ error: 'Gmail credentials not configured' });
    }

    try {
        const transporter = await createTransporter();
        await transporter.sendMail({
            from: `"KI Contact Center" <${EMAIL_CONFIG.user}>`,
            to: email.fromAddress,
            subject: `Re: ${email.subject}`,
            text: replyText
        });

        email.status = 'replied';
        email.reply = replyText;
        email.repliedAt = new Date().toISOString();
        saveEmails();

        // Create ticket
        const ticketId = `T-${String(tickets.length + 1).padStart(4, '0')}`;
        tickets.push({
            id: ticketId, channel: 'email', date: new Date().toISOString(),
            message: `[${email.subject}] ${email.body.substring(0, 200)}`,
            reply: replyText.substring(0, 200),
            status: 'resolved', intent: email.intent || 'email'
        });
        saveTickets();

        res.json({ success: true, ticketId });
    } catch (err) {
        console.error('[EMAIL] Send error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/emails/:id
app.delete('/api/emails/:id', (req, res) => {
    emails = emails.filter(e => e.id !== req.params.id);
    saveEmails();
    res.json({ success: true });
});

console.log('  Email System loaded ✓');

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`KI-CallCenter running on http://0.0.0.0:${PORT}`);
});
