import { FormEvent, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  ArrowLeft, ArrowUpRight, AudioLines, CheckCheck,
  ChevronDown, Headphones, LogOut, Mic, MicOff, MoreHorizontal, Phone,
  PhoneCall, Plus, Search, Send, ShieldCheck, Smile, UserPlus,
  X,
} from 'lucide-react';

type User = { id: string; name: string; email: string; online?: boolean; lastSeen?: string };
type Message = { id: string; senderId: string; recipientId: string; text: string; createdAt: string };
type CallState = { peer: User; phase: 'incoming' | 'outgoing' | 'active'; offer?: RTCSessionDescriptionInit };

const tokenKey = 'relay-token';
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const clock = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function request<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data as T;
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || '');
  const [me, setMe] = useState<User | null>(null);
  const [people, setPeople] = useState<User[]>([]);
  const [selected, setSelected] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [peopleFilter, setPeopleFilter] = useState<'all' | 'online'>('all');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authName, setAuthName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [call, setCall] = useState<CallState | null>(null);
  const [muted, setMuted] = useState(false);
  const [mobileChat, setMobileChat] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const callRef = useRef<CallState | null>(null);
  const selectedRef = useRef<User | null>(null);
  const queuedIce = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => { callRef.current = call; }, [call]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    if (!token) { setMe(null); return; }
    request<{ user: User }>('/api/me', token).then(({ user }) => setMe(user)).catch(() => {
      localStorage.removeItem(tokenKey); setToken(''); setMe(null);
    });
  }, [token]);

  useEffect(() => {
    if (!me || !token) return;
    const client = io({ auth: { token } });
    setSocket(client);
    const refreshPeople = () => request<{ users: User[] }>('/api/users', token).then(({ users }) => setPeople(users));
    refreshPeople();
    client.on('presence:update', refreshPeople);
    client.on('message:new', (message: Message) => {
      setMessages((current) => {
        const active = selectedRef.current;
        const relevant = active && [message.senderId, message.recipientId].includes(active.id);
        return relevant && !current.some((item) => item.id === message.id) ? [...current, message] : current;
      });
      refreshPeople();
    });
    client.on('call:offer', ({ from, offer }: { from: User; offer: RTCSessionDescriptionInit }) => setCall({ peer: from, phase: 'incoming', offer }));
    client.on('call:answer', async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
      const connection = peerConnection.current;
      if (!connection) return;
      await connection.setRemoteDescription(answer);
      for (const candidate of queuedIce.current.splice(0)) await connection.addIceCandidate(candidate);
      setCall((current) => current ? { ...current, phase: 'active' } : current);
    });
    client.on('call:ice', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      const connection = peerConnection.current;
      if (!connection?.remoteDescription) queuedIce.current.push(candidate);
      else await connection.addIceCandidate(candidate).catch(() => undefined);
    });
    client.on('call:end', () => finishCall(false));
    return () => { client.disconnect(); setSocket(null); };
  }, [me, token]);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    if (!selected || !token) { setMessages([]); return; }
    request<{ messages: Message[] }>(`/api/messages/${selected.id}`, token)
      .then(({ messages: history }) => setMessages(history))
      .catch(() => setMessages([]));
  }, [selected, token]);

  async function submitAuth(event: FormEvent) {
    event.preventDefault(); setAuthError(''); setBusy(true);
    try {
      const result = await request<{ token: string; user: User }>(`/api/${authMode}`, undefined, {
        name: authName, email, password,
      });
      localStorage.setItem(tokenKey, result.token); setMe(result.user); setToken(result.token);
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Unable to sign in'); }
    finally { setBusy(false); }
  }

  function signOut() {
    finishCall(true); localStorage.removeItem(tokenKey); setToken(''); setMe(null); setPeople([]); setSelected(null); setMessages([]);
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selected || !text.trim() || !socket) return;
    socket.emit('message:send', { recipientId: selected.id, text: text.trim() }, (result: { error?: string }) => {
      if (result?.error) return;
      setText('');
    });
  }

  function createPeer(peer: User) {
    const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerConnection.current = connection;
    connection.onicecandidate = (event) => {
      if (event.candidate) socket?.emit('call:ice', { to: peer.id, candidate: event.candidate });
    };
    connection.ontrack = (event) => {
      if (remoteAudio.current) remoteAudio.current.srcObject = event.streams[0];
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') setCall((current) => current ? { ...current, phase: 'active' } : current);
      if (['failed', 'closed', 'disconnected'].includes(connection.connectionState) && callRef.current) finishCall(false);
    };
    localStream.current?.getTracks().forEach((track) => connection.addTrack(track, localStream.current!));
    return connection;
  }

  async function startCall(peer: User) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream.current = stream;
      const connection = createPeer(peer);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      setCall({ peer, phase: 'outgoing' });
      socket?.emit('call:offer', { to: peer.id, offer });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Microphone access is required to call');
    }
  }

  async function acceptCall() {
    const pending = callRef.current;
    if (!pending?.offer) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream.current = stream;
      const connection = createPeer(pending.peer);
      await connection.setRemoteDescription(pending.offer);
      for (const candidate of queuedIce.current.splice(0)) await connection.addIceCandidate(candidate);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      socket?.emit('call:answer', { to: pending.peer.id, answer });
      setCall({ ...pending, phase: 'active' });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not join call');
      finishCall(true);
    }
  }

  function finishCall(notify = true) {
    if (notify && callRef.current) socket?.emit('call:end', { to: callRef.current.peer.id });
    peerConnection.current?.close(); peerConnection.current = null;
    localStream.current?.getTracks().forEach((track) => track.stop()); localStream.current = null;
    queuedIce.current = [];
    if (remoteAudio.current) remoteAudio.current.srcObject = null;
    setCall(null); setMuted(false);
  }

  function toggleMute() {
    const next = !muted; setMuted(next);
    localStream.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
  }

  if (!me) return (
    <main className="auth-page">
      <div className="auth-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-mark">r<span>.</span></div><div className="art-note note-one">"you there?"</div><div className="art-note note-two">always.</div><div className="art-caption">Good conversations<br/>find their way.</div></div>
      <section className="auth-panel">
        <div className="auth-top"><div className="brand"><span className="brand-icon">r</span> relay</div><span className="auth-top-note"><ShieldCheck size={14}/> Private by default</span></div>
        <div className="auth-content">
          <span className="eyebrow">A little closer, wherever you are</span>
          <h1>{authMode === 'login' ? <>Come on<br/> <em>in.</em></> : <>Make room<br/> <em>for more.</em></>}</h1>
          <p className="auth-copy">Messages, voices, and the people you keep close. All in one place.</p>
          <form className="auth-form" onSubmit={submitAuth}>
            {authMode === 'register' && <label>Your name<input autoComplete="name" value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder="Sam Rivera" required /></label>}
            <label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></label>
            <label>Password<input type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" minLength={8} required /></label>
            {authError && <p className="form-error">{authError}</p>}
            <button className="primary-button auth-submit" disabled={busy}>{busy ? 'One moment…' : authMode === 'login' ? 'Sign in' : 'Create your account'} <ArrowUpRight size={17}/></button>
          </form>
          <p className="switch-auth">{authMode === 'login' ? 'New around here?' : 'Already have a place here?'} <button onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(''); }}>{authMode === 'login' ? 'Create account' : 'Sign in'}</button></p>
        </div>
        <div className="auth-footer"><span>RELAY / PERSONAL CONNECTION, REIMAGINED</span><span>EST. 2025</span></div>
      </section>
    </main>
  );

  const filteredPeople = people.filter((person) => {
    const matchesQuery = person.name.toLowerCase().includes(query.toLowerCase()) || person.email.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (peopleFilter === 'all' || person.online);
  });
  const lastMessages = new Map<string, Message>();
  for (const message of messages) lastMessages.set(message.senderId === me.id ? message.recipientId : message.senderId, message);

  return (
    <main className={`app-shell ${mobileChat ? 'show-chat' : ''}`}>
      <aside className="rail">
        <div className="brand rail-brand"><span className="brand-icon">r</span><span>relay</span></div>
        <div className="rail-tools"><button className="rail-active" title="Messages" onClick={() => { setSelected(null); setMobileChat(false); }}><AudioLines size={20}/></button><button title="People" onClick={() => document.querySelector<HTMLInputElement>('.search-box input')?.focus()}><UserPlus size={19}/></button></div>
        <div className="rail-bottom"><button className="avatar rail-avatar" title={me.name}>{initials(me.name)}</button></div>
      </aside>
      <aside className="inbox">
        <header className="inbox-header"><div><div className="section-label">YOUR SPACE</div><h2>Messages <span>{people.length}</span></h2></div><button className="icon-button compose-button" title="New conversation" onClick={() => document.querySelector<HTMLInputElement>('.search-box input')?.focus()}><Plus size={18}/></button></header>
        <label className="search-box"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find someone"/><span className="search-shortcut">/</span></label>
        <div className="inbox-tabs"><button className={peopleFilter === 'all' ? 'tab-selected' : ''} onClick={() => setPeopleFilter('all')}>All <span>{people.length}</span></button><button className={peopleFilter === 'online' ? 'tab-selected' : ''} onClick={() => setPeopleFilter('online')}>Online <i className="tab-dot"/></button></div>
        <div className="contact-list">
          {filteredPeople.length ? filteredPeople.map((person, index) => {
            const recent = lastMessages.get(person.id);
            return <button key={person.id} className={`contact ${selected?.id === person.id ? 'contact-selected' : ''}`} onClick={() => { setSelected(person); setMobileChat(true); }}>
              <div className={`avatar avatar-${index % 5}`}>{initials(person.name)}<i className={person.online ? 'online-dot' : 'offline-dot'}/></div>
              <div className="contact-copy"><div className="contact-top"><strong>{person.name}</strong><time>{recent ? clock(recent.createdAt) : ''}</time></div><p>{recent ? recent.text : person.online ? 'Around now' : 'Say hello'}</p></div>
            </button>;
          }) : <div className="empty-people"><div className="empty-icon"><UserPlus size={19}/></div><strong>No conversations yet</strong><p>Share Relay with someone and their account will appear here.</p></div>}
        </div>
        <div className="inbox-bottom"><div className="profile-row"><div className="avatar avatar-me">{initials(me.name)}<i className="online-dot"/></div><div className="profile-copy"><strong>{me.name}</strong><span>Available</span></div><button className="icon-button profile-menu" title="Sign out" onClick={signOut}><LogOut size={17}/></button></div></div>
      </aside>
      <section className="conversation">
        {selected ? <>
          <header className="conversation-header">
            <button className="icon-button back-button" onClick={() => setMobileChat(false)} title="Back to messages"><ArrowLeft size={18}/></button>
            <div className="avatar conversation-avatar">{initials(selected.name)}<i className={selected.online ? 'online-dot' : 'offline-dot'}/></div>
            <div className="conversation-person"><h2>{selected.name}</h2><span><i className={selected.online ? 'status-dot' : 'status-dot away'}/>{selected.online ? 'Online now' : 'Away'}</span></div>
            <div className="conversation-actions"><button className="icon-button call-action" title="Start voice call" onClick={() => startCall(selected)} disabled={!!call}><Phone size={18}/></button><button className="icon-button" title="More options"><MoreHorizontal size={19}/></button></div>
          </header>
          <div className="message-area">
            <div className="thread-intro"><div className="avatar intro-avatar">{initials(selected.name)}</div><h3>You and {selected.name.split(' ')[0]}</h3><p>This is the beginning of something good.</p><span>DIRECT CONVERSATION</span></div>
            <div className="message-list">
              {messages.map((message, index) => {
                const own = message.senderId === me.id;
                const prior = messages[index - 1];
                const grouped = prior?.senderId === message.senderId && new Date(message.createdAt).getTime() - new Date(prior.createdAt).getTime() < 300000;
                return <div key={message.id} className={`message-row ${own ? 'message-own' : ''} ${grouped ? 'message-grouped' : ''}`}>
                  {!own && !grouped && <div className="avatar message-avatar">{initials(selected.name)}</div>}
                  {!own && grouped && <div className="avatar-spacer"/>}
                  <div className="message-content"><div className="message-bubble">{message.text}</div><div className="message-meta">{!grouped && <span>{own ? 'You' : selected.name.split(' ')[0]} · </span>}{clock(message.createdAt)} {own && <CheckCheck size={13} className="read-check"/>}</div></div>
                </div>;
              })}
              <div ref={messagesEnd}/>
            </div>
          </div>
          <form className="composer" onSubmit={sendMessage}><div className="composer-tools"><button type="button" className="icon-button" title="Attach a file"><Plus size={18}/></button></div><input value={text} onChange={(event) => setText(event.target.value)} placeholder={`Message ${selected.name.split(' ')[0]}…`} aria-label="Message"/><button type="button" className="icon-button emoji-button" title="Emoji"><Smile size={18}/></button><button className="send-button" title="Send message" disabled={!text.trim()}><Send size={17}/></button></form>
          <div className="conversation-footnote"><span>MESSAGES ARE JUST BETWEEN YOU TWO</span><span><ChevronDown size={12}/> ENTER TO SEND</span></div>
        </> : <div className="welcome-state"><div className="welcome-symbol"><AudioLines size={26}/></div><span className="eyebrow">YOUR PEOPLE, RIGHT HERE</span><h2>A good conversation<br/><em>starts somewhere.</em></h2><p>Choose someone from your messages to pick up where you left off.</p><div className="welcome-line"><span/><span className="welcome-dot"/><span/></div></div>}
      </section>
      <aside className="details-pane">
        <div className="details-top"><span className="section-label">YOUR PEOPLE</span><button className="icon-button" title="More"><MoreHorizontal size={18}/></button></div>
        {selected ? <><div className="person-card"><div className="avatar person-avatar">{initials(selected.name)}<i className={selected.online ? 'online-dot' : 'offline-dot'}/></div><h2>{selected.name}</h2><span>{selected.email}</span><div className="person-presence"><i className={selected.online ? 'status-dot' : 'status-dot away'}/>{selected.online ? 'Available to chat' : 'Not online right now'}</div><div className="person-shortcuts"><button onClick={() => startCall(selected)} disabled={!!call}><PhoneCall size={17}/><span>Call</span></button><button onClick={() => document.querySelector<HTMLInputElement>('.composer input')?.focus()}><Send size={16}/><span>Message</span></button></div></div><div className="details-divider"/><div className="details-section"><div className="details-heading">Shared space <button className="icon-button" title="Add"><Plus size={16}/></button></div><div className="shared-empty"><div className="shared-icon"><Headphones size={17}/></div><p>Your calls together<br/>will show up here.</p></div></div><div className="details-bottom"><span><ShieldCheck size={14}/> PRIVATE CONVERSATION</span></div></> : <div className="details-quiet"><div className="quiet-line"/><p>Your closest circles,<br/>without the noise.</p><span>MESSAGES / CALLS / PEOPLE</span></div>}
      </aside>
      {call && <div className="call-overlay" role="dialog" aria-modal="true" aria-label="Voice call"><div className="call-window"><button className="icon-button call-close" onClick={() => finishCall(true)} title="End call"><X size={18}/></button><div className="call-orbit"><div className="avatar call-avatar">{initials(call.peer.name)}</div><span className="call-pulse"/></div><span className="call-label">{call.phase === 'incoming' ? 'INCOMING VOICE CALL' : call.phase === 'outgoing' ? 'REACHING OUT' : 'VOICE CONNECTION'}</span><h2>{call.peer.name}</h2><p>{call.phase === 'incoming' ? 'is calling you' : call.phase === 'outgoing' ? 'Waiting for them to pick up…' : 'You’re connected'}</p><div className="call-wave"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div><div className="call-controls">{call.phase === 'incoming' ? <><button className="decline-call" title="Decline call" onClick={() => finishCall(true)}><Phone size={18}/></button><button className="accept-call" title="Accept call" onClick={acceptCall}><Phone size={18}/></button></> : <><button className={`mute-call ${muted ? 'is-muted' : ''}`} title={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={toggleMute}>{muted ? <MicOff size={19}/> : <Mic size={19}/>}</button><button className="decline-call" title="End call" onClick={() => finishCall(true)}><Phone size={18}/></button></>}</div><span className="call-encryption"><ShieldCheck size={13}/> PEER-TO-PEER AUDIO</span></div></div>}
      <audio ref={remoteAudio} autoPlay/>
      {authError && me && <div className="toast" role="status">{authError}<button onClick={() => setAuthError('')} aria-label="Dismiss"><X size={15}/></button></div>}
    </main>
  );
}
