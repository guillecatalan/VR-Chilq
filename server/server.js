import express from 'express';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import http from 'http';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 8080;

// NOTE ON PERSISTENCE: this SQLite file lives on local disk. On most free
// hosting tiers (Render free web service, etc.) the disk is wiped on every
// redeploy/restart — fine for testing, NOT fine for real EHS records. Once
// this is used for real safety observations, move `tags` to a managed DB
// (e.g. a free Supabase/Postgres instance) so a redeploy can't erase them.
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
    const rows = db.prepare('SELECT * FROM tags WHERE room = ?').all(room);
    res.json(rows);
});

app.post('/tags', (req, res) => {
    const { room = 'default', x, y, z, note, author } = req.body;
    const id = randomUUID();
    const created_at = Date.now();
    db.prepare(
        'INSERT INTO tags (id, room, x, y, z, note, author, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(id, room, x, y, z, note, author || 'anon', created_at);
    const tag = { id, room, x, y, z, note, author, created_at };
    broadcast(room, { type: 'tag-created', tag });
    res.json(tag);
});

app.delete('/tags/:id', (req, res) => {
    db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// room -> Map(clientId -> ws)
const rooms = new Map();

function broadcast(room, data, exceptId = null) {
    const clients = rooms.get(room);
    if (!clients) return;
    const msg = JSON.stringify(data);
    for (const [id, ws] of clients) {
        if (id !== exceptId && ws.readyState === ws.OPEN) ws.send(msg);
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
            if (!rooms.has(room)) rooms.set(room, new Map());
            rooms.get(room).set(clientId, ws);
            ws.send(JSON.stringify({ type: 'joined', id: clientId }));
            broadcast(room, { type: 'peer-joined', id: clientId }, clientId);
            return;
        }

        if (!room) return; // must join before anything else

        if (msg.type === 'pose') {
            // Relay this player's head/hand transforms to everyone else in the room.
            // Deliberately NOT persisted — poses are ephemeral, only tags are.
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

server.listen(PORT, () => console.log(`XR multiplayer server listening on ${PORT}`));
