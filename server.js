require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

const API_KEYS = {
    anthropic: process.env.ANTHROPIC_API_KEY || ''
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

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
    console.log(`KI-CallCenter running on http://localhost:${PORT}`);
});
