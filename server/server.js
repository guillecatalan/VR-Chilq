import express from 'express';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import http from 'http';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 8080;
const MAX_TAGS_PER_ROOM = 25;

// NOTE ON PERSISTENCE: this SQLite file lives on local disk. On most free
// hosting tiers (Render free web service, etc.) the disk is wiped on every
// redeploy/restart — fine for testing, NOT fine for real EHS records. Once
// this is used for real safety observations, move `tags` to a managed DB.
const db = new Database('tags.db');
db.exec(`
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  x REAL, y REAL, z REAL,
  note TEXT,
  author TEXT,
  created_at INTEGER
)`);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/tags', (req, res) => {
    const room = req.query.room || 'default';
    const rows = db.prepare(
        'SELECT * FROM tags WHERE room = ? ORDER BY created_at ASC'
    ).all(room);
    res.json(rows);
});

app.post('/tags', (req, res) => {
    const { room = 'default', x, y, z, note, author } = req.body;

    // Server-side limit: clients cannot bypass the 25-tag room limit.
    const count = db.prepare('SELECT COUNT(*) AS count FROM tags WHERE room = ?').get(room).count;
    if (count >= MAX_TAGS_PER_ROOM) {
        return res.status(409).json({
            ok: false,
            limitReached: true,
            maxTags: MAX_TAGS_PER_ROOM,
            message: `La sala ya tiene el máximo de ${MAX_TAGS_PER_ROOM} tags.`
        });
    }

    if (![x, y, z].every(Number.isFinite)) {
        return res.status(400).json({ ok: false, message: 'Coordenadas inválidas.' });
    }

    const cleanNote = String(note ?? '').trim();
    if (!cleanNote) {
        return res.status(400).json({ ok: false, message: 'El tag no puede estar vacío.' });
    }

    const id = randomUUID();
    const created_at = Date.now();

    db.prepare(
        'INSERT INTO tags (id, room, x, y, z, note, author, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(id, room, x, y, z, cleanNote, author || 'anon', created_at);

    const tag = {
        id,
        room,
        x,
        y,
        z,
        note: cleanNote,
        author: author || 'anon',
        created_at
    };

    broadcast(room, { type: 'tag-created', tag });
    res.json(tag);
});

app.delete('/tags/:id', (req, res) => {
    const result = db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
    res.json({ ok: true, deleted: result.changes > 0 });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// room -> Map(clientId -> ws)
const rooms = new Map();

function broadcast(room, data, exceptId = null) {
    const clients = rooms.get(room);
    if (!clients) return;
    const msg = JSON.stringify(data);
    for (const [id, client] of clients) {
        if (id !== exceptId && client.ws.readyState === client.ws.OPEN) client.ws.send(msg);
    }
}

wss.on('connection', (ws) => {
    let room = null;
    const clientId = randomUUID();

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        if (msg.type === 'join') {
            room = msg.room || 'default';
            const name = String(msg.name || '').trim().slice(0, 40) || 'Anónimo';
            if (!rooms.has(room)) rooms.set(room, new Map());
            rooms.get(room).set(clientId, { ws, name });

            ws.send(JSON.stringify({ type: 'joined', id: clientId }));

            // Tell the newly-joined client who's already here, so its
            // "Usuarios" panel is correct immediately, not only after
            // someone else joins/moves later.
            const peers = Array.from(rooms.get(room).entries())
                .filter(([id]) => id !== clientId)
                .map(([id, c]) => ({ id, name: c.name }));
            ws.send(JSON.stringify({ type: 'peers', peers }));

            broadcast(room, { type: 'peer-joined', id: clientId, name }, clientId);
            return;
        }

        if (!room) return;

        if (msg.type === 'pose') {
            broadcast(room, { type: 'pose', id: clientId, pose: msg.pose }, clientId);
        }
    });

    ws.on('close', () => {
        if (room && rooms.has(room)) {
            rooms.get(room).delete(clientId);
            broadcast(room, { type: 'peer-left', id: clientId });
        }
    });
});

server.listen(PORT, () => console.log(`XR multiplayer server listening on ${PORT}; max tags/room=${MAX_TAGS_PER_ROOM}`));
