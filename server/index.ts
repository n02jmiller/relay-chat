import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

type StoredUser = { id: string; name: string; email: string; passwordHash: string; createdAt: string };
type GroupConversation = { id: string; name: string; memberIds: string[]; createdAt: string };
type ChatMessage = { id: string; senderId: string; recipientId: string; groupId?: string; text: string; createdAt: string };
type Database = { users: StoredUser[]; messages: ChatMessage[]; groups: GroupConversation[] };
type AuthedSocket = Socket & { data: { userId?: string } };

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.RELAY_DATA_FILE || path.join(here, 'data.json');
const secret = process.env.RELAY_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === 'production';
const clientBuild = path.resolve(here, '..', 'dist');
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

if (isProduction && !process.env.RELAY_TOKEN_SECRET) {
  throw new Error('RELAY_TOKEN_SECRET must be set in production.');
}

function loadDatabase(): Database {
  try {
    const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as Partial<Database>;
    return { users: stored.users || [], messages: stored.messages || [], groups: stored.groups || [] };
  } catch { return { users: [], messages: [], groups: [] }; }
}
const database = loadDatabase();
let saveQueue = Promise.resolve();
function saveDatabase() {
  if (pool) {
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
      await pool.query(
        'INSERT INTO relay_state (state_key, payload) VALUES ($1, $2::jsonb) ON CONFLICT (state_key) DO UPDATE SET payload = EXCLUDED.payload',
        ['main', JSON.stringify(database)],
      );
    });
    return saveQueue;
  }
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(database, null, 2));
  return Promise.resolve();
}
async function initializeStorage() {
  if (!pool) return;
  await pool.query('CREATE TABLE IF NOT EXISTS relay_state (state_key text PRIMARY KEY, payload jsonb NOT NULL)');
  const result = await pool.query<{ payload: Partial<Database> }>('SELECT payload FROM relay_state WHERE state_key = $1', ['main']);
  if (result.rows[0]) {
    const stored = result.rows[0].payload;
    database.users = stored.users || [];
    database.messages = stored.messages || [];
    database.groups = stored.groups || [];
  } else {
    await saveDatabase();
  }
}
function publicUser(user: StoredUser) {
  return { id: user.id, name: user.name, email: user.email };
}
function signToken(userId: string) {
  const payload = Buffer.from(JSON.stringify({ userId, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 14 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function verifyToken(token?: string) {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { userId: string; expiresAt: number };
    return decoded.expiresAt > Date.now() ? database.users.find((user) => user.id === decoded.userId) || null : null;
  } catch { return null; }
}
function requireUser(request: express.Request, response: express.Response, next: express.NextFunction) {
  const user = verifyToken(request.header('authorization')?.replace(/^Bearer\s+/i, ''));
  if (!user) { response.status(401).json({ error: 'Please sign in again.' }); return; }
  response.locals.user = user;
  next();
}
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (request, response) => response.json({ status: 'ok', persistentStorage: Boolean(pool) || !isProduction }));
app.post('/api/register', async (request, response) => {
  const name = typeof request.body.name === 'string' ? request.body.name.trim().replace(/\s+/g, ' ') : '';
  const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  if (name.length < 2 || name.length > 50) { response.status(400).json({ error: 'Name must be between 2 and 50 characters.' }); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) { response.status(400).json({ error: 'Enter a valid email address.' }); return; }
  if (password.length < 8 || password.length > 128) { response.status(400).json({ error: 'Password must be at least 8 characters.' }); return; }
  if (database.users.some((user) => user.email === email)) { response.status(409).json({ error: 'An account with that email already exists.' }); return; }
  const user: StoredUser = { id: crypto.randomUUID(), name, email, passwordHash: await bcrypt.hash(password, 12), createdAt: new Date().toISOString() };
  database.users.push(user); await saveDatabase();
  response.status(201).json({ token: signToken(user.id), user: publicUser(user) });
});
app.post('/api/login', async (request, response) => {
  const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const user = database.users.find((candidate) => candidate.email === email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) { response.status(401).json({ error: 'That email and password do not match.' }); return; }
  response.json({ token: signToken(user.id), user: publicUser(user) });
});
app.get('/api/me', requireUser, (request, response) => response.json({ user: publicUser(response.locals.user as StoredUser) }));

const httpServer = createServer(app);
const io = new Server(httpServer);
const activeSockets = new Map<string, Set<string>>();
const onlineIds = () => [...activeSockets.keys()];

app.get('/api/users', requireUser, (request, response) => {
  const user = response.locals.user as StoredUser;
  response.json({ users: database.users.filter((candidate) => candidate.id !== user.id).map((candidate) => ({ ...publicUser(candidate), online: activeSockets.has(candidate.id) })) });
});
app.get('/api/groups', requireUser, (request, response) => {
  const user = response.locals.user as StoredUser;
  response.json({ groups: database.groups.filter((group) => group.memberIds.includes(user.id)) });
});
app.post('/api/groups', requireUser, (request, response) => {
  const user = response.locals.user as StoredUser;
  const name = typeof request.body.name === 'string' ? request.body.name.trim().replace(/\s+/g, ' ') : '';
  const requestedIds = Array.isArray(request.body.memberIds) ? request.body.memberIds.filter((id: unknown): id is string => typeof id === 'string') : [];
  const memberIds = [...new Set([user.id, ...requestedIds])];
  if (name.length < 2 || name.length > 60) { response.status(400).json({ error: 'Group name must be between 2 and 60 characters.' }); return; }
  if (memberIds.length < 2 || memberIds.length > 20 || memberIds.some((id) => !database.users.some((candidate) => candidate.id === id))) {
    response.status(400).json({ error: 'Choose between 1 and 19 other registered people.' }); return;
  }
  const group: GroupConversation = { id: crypto.randomUUID(), name, memberIds, createdAt: new Date().toISOString() };
  database.groups.push(group); await saveDatabase();
  response.status(201).json({ group });
});
app.get('/api/messages/:peerId', requireUser, (request, response) => {
  const user = response.locals.user as StoredUser;
  const peerId = request.params.peerId;
  const group = database.groups.find((candidate) => candidate.id === peerId);
  const peer = database.users.find((candidate) => candidate.id === peerId);
  if (group ? !group.memberIds.includes(user.id) : !peer) { response.status(404).json({ error: 'Conversation not found.' }); return; }
  const allMessages = database.messages.filter((message) => group
    ? message.groupId === group.id
    : !message.groupId && ((message.senderId === user.id && message.recipientId === peerId) || (message.senderId === peerId && message.recipientId === user.id)))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const before = typeof request.query.before === 'string' ? Date.parse(request.query.before) : Number.NaN;
  const beforeId = typeof request.query.beforeId === 'string' ? request.query.beforeId : '';
  const eligible = Number.isFinite(before) ? allMessages.filter((message) => {
    const time = Date.parse(message.createdAt);
    return time < before || (time === before && beforeId && message.id.localeCompare(beforeId) < 0);
  }) : allMessages;
  const limitValue = Number(request.query.limit);
  const limit = Number.isInteger(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 50;
  const hasMore = eligible.length > limit;
  const messages = eligible.slice(-limit);
  response.json({ messages, hasMore });
});

if (isProduction) {
  app.use(express.static(clientBuild, { index: false }));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/')) { next(); return; }
    response.sendFile(path.join(clientBuild, 'index.html'), (error) => {
      if (error) next(error);
    });
  });
}

io.use((socket, next) => {
  const user = verifyToken(socket.handshake.auth?.token as string | undefined);
  if (!user) { next(new Error('Please sign in again.')); return; }
  (socket as AuthedSocket).data.userId = user.id;
  next();
});
function emitPresence() { io.emit('presence:update', onlineIds()); }
function relayToPeer(socket: AuthedSocket, event: string, peerId: unknown, payload: Record<string, unknown> = {}) {
  if (typeof peerId !== 'string' || !database.users.some((user) => user.id === peerId)) return;
  const sender = database.users.find((user) => user.id === socket.data.userId);
  if (sender) io.to(`user:${peerId}`).emit(event, { ...payload, from: publicUser(sender) });
}

io.on('connection', (rawSocket) => {
  const socket = rawSocket as AuthedSocket;
  const userId = socket.data.userId!;
  socket.join(`user:${userId}`);
  const sockets = activeSockets.get(userId) || new Set<string>();
  sockets.add(socket.id); activeSockets.set(userId, sockets);
  emitPresence();

  socket.on('message:send', async (payload: { recipientId?: unknown; groupId?: unknown; text?: unknown }, acknowledge?: (result: { error?: string; message?: ChatMessage }) => void) => {
    const recipientId = payload?.recipientId;
    const groupId = typeof payload?.groupId === 'string' ? payload.groupId : undefined;
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    const group = groupId ? database.groups.find((candidate) => candidate.id === groupId) : undefined;
    const directRecipient = typeof recipientId === 'string' && database.users.some((candidate) => candidate.id === recipientId && candidate.id !== userId);
    if (groupId ? !group?.memberIds.includes(userId) : !directRecipient) { acknowledge?.({ error: 'Choose a valid conversation to message.' }); return; }
    if (!text || text.length > 5000) { acknowledge?.({ error: 'Messages must be between 1 and 5000 characters.' }); return; }
    const message: ChatMessage = { id: crypto.randomUUID(), senderId: userId, recipientId: groupId || recipientId as string, ...(groupId ? { groupId } : {}), text, createdAt: new Date().toISOString() };
    database.messages.push(message);
    try { await saveDatabase(); } catch { acknowledge?.({ error: 'Could not save your message. Please try again.' }); return; }
    const recipients = group ? group.memberIds : [userId, recipientId as string];
    for (const recipient of recipients) io.to(`user:${recipient}`).emit('message:new', message);
    acknowledge?.({ message });
  });
  socket.on('call:offer', (payload: { to?: unknown; offer?: unknown; mode?: unknown }) => relayToPeer(socket, 'call:offer', payload?.to, { offer: payload?.offer, mode: payload?.mode === 'video' ? 'video' : 'audio' }));
  socket.on('call:answer', (payload: { to?: unknown; answer?: unknown }) => relayToPeer(socket, 'call:answer', payload?.to, { answer: payload?.answer }));
  socket.on('call:ice', (payload: { to?: unknown; candidate?: unknown }) => relayToPeer(socket, 'call:ice', payload?.to, { candidate: payload?.candidate }));
  socket.on('call:end', (payload: { to?: unknown }) => relayToPeer(socket, 'call:end', payload?.to));
  socket.on('call:groupInvite', (payload: { groupId?: unknown; roomId?: unknown }) => {
    const group = database.groups.find((candidate) => candidate.id === payload?.groupId && candidate.memberIds.includes(userId));
    const roomId = typeof payload?.roomId === 'string' && /^Relay-[a-f0-9-]{36}$/i.test(payload.roomId) ? payload.roomId : null;
    const sender = database.users.find((candidate) => candidate.id === userId);
    if (!group || !roomId || !sender) return;
    for (const memberId of group.memberIds) {
      if (memberId !== userId) io.to(`user:${memberId}`).emit('call:groupInvite', { from: publicUser(sender), groupId: group.id, groupName: group.name, roomId });
    }
  });
  socket.on('disconnect', () => {
    const current = activeSockets.get(userId);
    current?.delete(socket.id);
    if (!current?.size) activeSockets.delete(userId);
    emitPresence();
  });
});

initializeStorage().then(() => {
  httpServer.listen(port, () => console.log(`Relay API and signaling server listening on http://localhost:${port}`));
}).catch((error: unknown) => {
  console.error('Could not initialize persistent storage:', error);
  process.exit(1);
});
