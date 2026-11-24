import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  ArrowLeft, ArrowUpRight, AudioLines, CheckCheck,
  ChevronDown, Download, Headphones, LogOut, Mic, MicOff, MoreHorizontal, Phone,
  Plus, Search, Send, ShieldCheck, Smile, UserPlus, Video, VideoOff,
  X,
} from 'lucide-react';

type User = { id: string; name: string; email: string; online?: boolean; lastSeen?: string };
type Group = { id: string; name: string; memberIds: string[]; createdAt: string };
type ChatTarget = { id: string; name: string; email?: string; online?: boolean; group?: boolean; memberIds?: string[] };
type Message = { id: string; senderId: string; recipientId: string; groupId?: string; text: string; createdAt: string };
type CallState = { peer: User; phase: 'incoming' | 'outgoing' | 'active'; mode: 'audio' | 'video'; offer?: RTCSessionDescriptionInit; groupCall?: { groupId: string; name: string; roomId: string } };

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
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<ChatTarget | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [peopleFilter, setPeopleFilter] = useState<'all' | 'online'>('all');
  const [groupModal, setGroupModal] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authName, setAuthName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [call, setCall] = useState<CallState | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [mobileChat, setMobileChat] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const messagesArea = useRef<HTMLDivElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const hasMoreRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const pendingScrollAdjustment = useRef<{ height: number; top: number } | null>(null);
  const wasAtBottom = useRef(true);
  const initialHistoryLoad = useRef(false);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const callRef = useRef<CallState | null>(null);
  const selectedRef = useRef<ChatTarget | null>(null);
  const queuedIce = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => { callRef.current = call; }, [call]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { hasMoreRef.current = hasMoreMessages; }, [hasMoreMessages]);
  useEffect(() => { loadingOlderRef.current = loadingOlder; }, [loadingOlder]);
  useEffect(() => {
    if (call?.mode === 'video' && localVideo.current && localStream.current) localVideo.current.srcObject = localStream.current;
  }, [call]);

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
      setCanInstall(true);
    };
    const handleInstalled = () => { setCanInstall(false); setInstallPrompt(null); };
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

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
    const refreshGroups = () => request<{ groups: Group[] }>('/api/groups', token).then(({ groups }) => setGroups(groups));
    refreshPeople();
    refreshGroups();
    client.on('presence:update', refreshPeople);
    client.on('message:new', (message: Message) => {
      setMessages((current) => {
        const active = selectedRef.current;
        const relevant = active && (active.group ? message.groupId === active.id : !message.groupId && [message.senderId, message.recipientId].includes(active.id));
        return relevant && !current.some((item) => item.id === message.id) ? [...current, message] : current;
      });
      refreshPeople();
    });
    client.on('call:offer', ({ from, offer, mode }: { from: User; offer: RTCSessionDescriptionInit; mode?: 'audio' | 'video' }) => setCall({ peer: from, phase: 'incoming', mode: mode || 'audio', offer }));
    client.on('call:groupInvite', ({ from, groupId, groupName, roomId }: { from: User; groupId: string; groupName: string; roomId: string }) => {
      setCall({ peer: from, phase: 'incoming', mode: 'video', groupCall: { groupId, name: groupName, roomId } });
    });
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

  useLayoutEffect(() => {
    const area = messagesArea.current;
    if (!area || !messages.length) return;
    const adjustment = pendingScrollAdjustment.current;
    if (adjustment) {
      area.scrollTop = adjustment.top + area.scrollHeight - adjustment.height;
      pendingScrollAdjustment.current = null;
    } else if (initialHistoryLoad.current || wasAtBottom.current) {
      area.scrollTop = area.scrollHeight;
      initialHistoryLoad.current = false;
    }
  }, [messages]);

  useEffect(() => {
    if (!selected || !token) { setMessages([]); return; }
    let active = true;
    initialHistoryLoad.current = true;
    setMessages([]);
    setOlderError('');
    setHasMoreMessages(false);
    request<{ messages: Message[]; hasMore: boolean }>(`/api/messages/${selected.id}?limit=50`, token)
      .then(({ messages: history, hasMore }) => {
        if (!active) return;
        setMessages(history);
        setHasMoreMessages(hasMore);
      })
      .catch(() => { if (active) setMessages([]); });
    return () => { active = false; };
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
    finishCall(true); localStorage.removeItem(tokenKey); setToken(''); setMe(null); setPeople([]); setGroups([]); setSelected(null); setMessages([]);
  }

  async function loadOlderMessages() {
    if (!selected || !token || !hasMoreRef.current || loadingOlderRef.current || !messages.length) return;
    const area = messagesArea.current;
    if (!area) return;
    setLoadingOlder(true); setOlderError('');
    const firstMessage = messages[0];
    pendingScrollAdjustment.current = { height: area.scrollHeight, top: area.scrollTop };
    try {
      const { messages: older, hasMore } = await request<{ messages: Message[]; hasMore: boolean }>(
        `/api/messages/${selected.id}?limit=50&before=${encodeURIComponent(firstMessage.createdAt)}&beforeId=${encodeURIComponent(firstMessage.id)}`, token,
      );
      if (selectedRef.current?.id !== selected.id) { pendingScrollAdjustment.current = null; return; }
      setMessages((current) => [...older, ...current.filter((message) => !older.some((item) => item.id === message.id))]);
      setHasMoreMessages(hasMore);
    } catch (error) {
      pendingScrollAdjustment.current = null;
      setOlderError(error instanceof Error ? error.message : 'Could not load earlier messages');
    } finally { setLoadingOlder(false); }
  }

  function handleMessageScroll() {
    const area = messagesArea.current;
    if (!area) return;
    wasAtBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
    if (area.scrollTop < 70) void loadOlderMessages();
  }

  async function installApp() {
    if (!installPrompt) {
      setAuthError('To install Relay, open your browser menu and choose Install app or Add to Home Screen.');
      return;
    }
    const prompt = installPrompt as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === 'accepted') { setCanInstall(false); setInstallPrompt(null); }
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    try {
      const { group } = await request<{ group: Group }>('/api/groups', token, { name: groupName, memberIds: groupMembers });
      setGroups((current) => [group, ...current]);
      setSelected({ id: group.id, name: group.name, group: true, memberIds: group.memberIds });
      setGroupModal(false); setGroupName(''); setGroupMembers([]); setMobileChat(true);
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Could not create group'); }
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selected || !text.trim() || !socket) return;
    socket.emit('message:send', { ...(selected.group ? { groupId: selected.id } : { recipientId: selected.id }), text: text.trim() }, (result: { error?: string }) => {
      if (result?.error) return;
      setText('');
    });
  }

  function addEmoji(emoji: string) {
    setText((current) => `${current}${emoji}`);
    setEmojiPickerOpen(false);
    document.querySelector<HTMLInputElement>('.composer input')?.focus();
  }

  function createPeer(peer: User, mode: 'audio' | 'video') {
    const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerConnection.current = connection;
    connection.onicecandidate = (event) => {
      if (event.candidate) socket?.emit('call:ice', { to: peer.id, candidate: event.candidate });
    };
    connection.ontrack = (event) => {
      if (remoteAudio.current && mode === 'audio') remoteAudio.current.srcObject = event.streams[0];
      if (remoteVideo.current && mode === 'video') remoteVideo.current.srcObject = event.streams[0];
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') setCall((current) => current ? { ...current, phase: 'active' } : current);
      if (['failed', 'closed', 'disconnected'].includes(connection.connectionState) && callRef.current) finishCall(false);
    };
    localStream.current?.getTracks().forEach((track) => connection.addTrack(track, localStream.current!));
    return connection;
  }

  async function startCall(peer: User, mode: 'audio' | 'video' = 'audio') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' });
      localStream.current = stream;
      if (localVideo.current && mode === 'video') localVideo.current.srcObject = stream;
      const connection = createPeer(peer, mode);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      setCall({ peer, phase: 'outgoing', mode });
      socket?.emit('call:offer', { to: peer.id, offer, mode });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Microphone access is required to call');
    }
  }

  async function acceptCall() {
    const pending = callRef.current;
    if (pending?.groupCall) {
      setCall({ ...pending, phase: 'active' });
      return;
    }
    if (!pending?.offer) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: pending.mode === 'video' });
      localStream.current = stream;
      if (localVideo.current && pending.mode === 'video') localVideo.current.srcObject = stream;
      const connection = createPeer(pending.peer, pending.mode);
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
    const activeCall = callRef.current;
    if (notify && activeCall && !activeCall.groupCall) socket?.emit('call:end', { to: activeCall.peer.id });
    peerConnection.current?.close(); peerConnection.current = null;
    localStream.current?.getTracks().forEach((track) => track.stop()); localStream.current = null;
    queuedIce.current = [];
    if (remoteAudio.current) remoteAudio.current.srcObject = null;
    if (localVideo.current) localVideo.current.srcObject = null;
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    setCall(null); setMuted(false); setCameraOff(false);
  }

  function toggleMute() {
    const next = !muted; setMuted(next);
    localStream.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
  }

  function toggleCamera() {
    const next = !cameraOff; setCameraOff(next);
    localStream.current?.getVideoTracks().forEach((track) => { track.enabled = !next; });
  }

  function startGroupVideoCall(group: Group) {
    if (!socket || !me) return;
    const roomId = `Relay-${crypto.randomUUID()}`;
    const target = { groupId: group.id, name: group.name, roomId };
    socket.emit('call:groupInvite', { groupId: group.id, roomId });
    setCall({ peer: me, phase: 'active', mode: 'video', groupCall: target });
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
  const filteredGroups = groups.filter((group) => group.name.toLowerCase().includes(query.toLowerCase()));
  const conversationTargets: ChatTarget[] = [
    ...filteredGroups.map((group) => ({ id: group.id, name: group.name, group: true, memberIds: group.memberIds })),
    ...filteredPeople,
  ];
  const lastMessages = new Map<string, Message>();
  for (const message of messages) lastMessages.set(message.groupId || (message.senderId === me.id ? message.recipientId : message.senderId), message);

  return (
    <main className={`app-shell ${mobileChat ? 'show-chat' : ''}`}>
      <aside className="rail">
        <div className="brand rail-brand"><span className="brand-icon">r</span><span>relay</span></div>
        <div className="rail-tools"><button className="rail-active" title="Messages" onClick={() => { setSelected(null); setMobileChat(false); }}><AudioLines size={20}/></button><button title="People" onClick={() => document.querySelector<HTMLInputElement>('.search-box input')?.focus()}><UserPlus size={19}/></button></div>
        <div className="rail-bottom"><button className="avatar rail-avatar" title={me.name}>{initials(me.name)}</button></div>
      </aside>
      <aside className="inbox">
        <header className="inbox-header"><div><div className="section-label">YOUR SPACE</div><h2>Messages <span>{conversationTargets.length}</span></h2></div><div className="inbox-header-actions"><button className={`icon-button ${canInstall ? 'install-ready' : ''}`} title="Install Relay" onClick={installApp}><Download size={17}/></button><button className="icon-button compose-button" title="Create group chat" onClick={() => setGroupModal(true)}><Plus size={18}/></button></div></header>
        <label className="search-box"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find someone"/><span className="search-shortcut">/</span></label>
        <div className="inbox-tabs"><button className={peopleFilter === 'all' ? 'tab-selected' : ''} onClick={() => setPeopleFilter('all')}>All <span>{conversationTargets.length}</span></button><button className={peopleFilter === 'online' ? 'tab-selected' : ''} onClick={() => setPeopleFilter('online')}>Online <i className="tab-dot"/></button></div>
        <div className="contact-list">
          {conversationTargets.length ? conversationTargets.map((target, index) => {
            const recent = lastMessages.get(target.id);
            const memberCount = target.memberIds?.length || 0;
            return <button key={target.id} className={`contact ${selected?.id === target.id ? 'contact-selected' : ''}`} onClick={() => { setSelected(target); setMobileChat(true); }}>
              <div className={`avatar avatar-${index % 5} ${target.group ? 'group-avatar' : ''}`}>{initials(target.name)}{!target.group && <i className={target.online ? 'online-dot' : 'offline-dot'}/>}</div>
              <div className="contact-copy"><div className="contact-top"><strong>{target.name}</strong><time>{recent ? clock(recent.createdAt) : ''}</time></div><p>{recent ? recent.text : target.group ? `${memberCount} people` : target.online ? 'Around now' : 'Say hello'}</p></div>
            </button>;
          }) : <div className="empty-people"><div className="empty-icon"><UserPlus size={19}/></div><strong>No conversations yet</strong><p>Share Relay with someone and their account will appear here.</p></div>}
        </div>
        <div className="inbox-bottom"><div className="profile-row"><div className="avatar avatar-me">{initials(me.name)}<i className="online-dot"/></div><div className="profile-copy"><strong>{me.name}</strong><span>Available</span></div><button className="icon-button profile-menu" title="Sign out" onClick={signOut}><LogOut size={17}/></button></div></div>
      </aside>
      <section className="conversation">
        {selected ? <>
          <header className="conversation-header">
            <button className="icon-button back-button" onClick={() => setMobileChat(false)} title="Back to messages"><ArrowLeft size={18}/></button>
            <div className={`avatar conversation-avatar ${selected.group ? 'group-avatar' : ''}`}>{initials(selected.name)}{!selected.group && <i className={selected.online ? 'online-dot' : 'offline-dot'}/>}</div>
            <div className="conversation-person"><h2>{selected.name}</h2><span>{selected.group ? `${selected.memberIds?.length || 0} members` : <><i className={selected.online ? 'status-dot' : 'status-dot away'}/>{selected.online ? 'Online now' : 'Away'}</>}</span></div>
            <div className="conversation-actions">{selected.group ? <button className="icon-button call-action" title="Start group video chat" onClick={() => { const group = groups.find((candidate) => candidate.id === selected.id); if (group) startGroupVideoCall(group); }} disabled={!!call}><Video size={18}/></button> : <><button className="icon-button call-action" title="Start voice call" onClick={() => { const peer = people.find((person) => person.id === selected.id); if (peer) void startCall(peer, 'audio'); }} disabled={!!call}><Phone size={18}/></button><button className="icon-button call-action" title="Start video call" onClick={() => { const peer = people.find((person) => person.id === selected.id); if (peer) void startCall(peer, 'video'); }} disabled={!!call}><Video size={18}/></button></>}<button className="icon-button" title="More options"><MoreHorizontal size={19}/></button></div>
          </header>
          <div className="message-area" ref={messagesArea} onScroll={handleMessageScroll}>
            <div className="thread-intro"><div className={`avatar intro-avatar ${selected.group ? 'group-avatar' : ''}`}>{initials(selected.name)}</div><h3>{selected.group ? selected.name : `You and ${selected.name.split(' ')[0]}`}</h3><p>{selected.group ? `${selected.memberIds?.length || 0} people in this conversation.` : 'This is the beginning of something good.'}</p><span>{selected.group ? 'GROUP CONVERSATION' : 'DIRECT CONVERSATION'}</span></div>
            {(loadingOlder || hasMoreMessages) && <div className="history-status">{loadingOlder ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}</div>}
            {olderError && <button className="history-error" onClick={() => void loadOlderMessages()}>{olderError} · Tap to retry</button>}
            <div className="message-list">
              {messages.map((message, index) => {
                const own = message.senderId === me.id;
                const prior = messages[index - 1];
                const grouped = prior?.senderId === message.senderId && new Date(message.createdAt).getTime() - new Date(prior.createdAt).getTime() < 300000;
                const senderName = own ? 'You' : selected.group ? people.find((person) => person.id === message.senderId)?.name || 'A member' : selected.name.split(' ')[0];
                return <div key={message.id} className={`message-row ${own ? 'message-own' : ''} ${grouped ? 'message-grouped' : ''}`}>
                  {!own && !grouped && <div className="avatar message-avatar">{initials(senderName)}</div>}
                  {!own && grouped && <div className="avatar-spacer"/>}
                  <div className="message-content"><div className="message-bubble">{message.text}</div><div className="message-meta">{!grouped && <span>{senderName} · </span>}{clock(message.createdAt)} {own && <CheckCheck size={13} className="read-check"/>}</div></div>
                </div>;
              })}
              <div ref={messagesEnd}/>
            </div>
          </div>
          <form className="composer" onSubmit={sendMessage}><div className="composer-tools"><button type="button" className="icon-button" title="Attach a file"><Plus size={18}/></button></div><input value={text} onChange={(event) => setText(event.target.value)} placeholder={`Message ${selected.group ? selected.name : selected.name.split(' ')[0]}…`} aria-label="Message"/><div className="emoji-picker-container"><button type="button" className="icon-button emoji-button" title="Choose emoji" aria-expanded={emojiPickerOpen} onClick={() => setEmojiPickerOpen((open) => !open)}><Smile size={18}/></button>{emojiPickerOpen && <div className="emoji-picker" role="group" aria-label="Choose an emoji">{['😀','😂','🥰','😍','😊','🙌','👏','🎉','❤️','👍','✨','😭','🤔','😎','🔥','🙏'].map((emoji) => <button type="button" key={emoji} onClick={() => addEmoji(emoji)} aria-label={`Add ${emoji}`}>{emoji}</button>)}</div>}</div><button className="send-button" title="Send message" disabled={!text.trim()}><Send size={17}/></button></form>
          <div className="conversation-footnote"><span>{selected.group ? 'A SHARED GROUP CONVERSATION' : 'MESSAGES ARE JUST BETWEEN YOU TWO'}</span><span><ChevronDown size={12}/> ENTER TO SEND</span></div>
        </> : <div className="welcome-state"><div className="welcome-symbol"><AudioLines size={26}/></div><span className="eyebrow">YOUR PEOPLE, RIGHT HERE</span><h2>A good conversation<br/><em>starts somewhere.</em></h2><p>Choose someone from your messages to pick up where you left off.</p><div className="welcome-line"><span/><span className="welcome-dot"/><span/></div></div>}
      </section>
      <aside className="details-pane">
        <div className="details-top"><span className="section-label">YOUR PEOPLE</span><button className="icon-button" title="More"><MoreHorizontal size={18}/></button></div>
        {selected ? <><div className="person-card"><div className={`avatar person-avatar ${selected.group ? 'group-avatar' : ''}`}>{initials(selected.name)}{!selected.group && <i className={selected.online ? 'online-dot' : 'offline-dot'}/>}</div><h2>{selected.name}</h2><span>{selected.group ? `${selected.memberIds?.length || 0} members` : selected.email}</span>{!selected.group && <div className="person-presence"><i className={selected.online ? 'status-dot' : 'status-dot away'}/>{selected.online ? 'Available to chat' : 'Not online right now'}</div>}<div className="person-shortcuts">{!selected.group && <button onClick={() => { const peer = people.find((person) => person.id === selected.id); if (peer) void startCall(peer, 'video'); }} disabled={!!call}><Video size={17}/><span>Video</span></button>}<button onClick={() => document.querySelector<HTMLInputElement>('.composer input')?.focus()}><Send size={16}/><span>Message</span></button></div></div><div className="details-divider"/><div className="details-section"><div className="details-heading">{selected.group ? 'People' : 'Shared space'}</div>{selected.group ? <div className="group-member-list">{selected.memberIds?.map((memberId) => { const member = memberId === me.id ? me : people.find((person) => person.id === memberId); return member ? <div className="group-member" key={memberId}><div className="avatar">{initials(member.name)}</div><span>{member.name}{memberId === me.id ? ' (you)' : ''}</span></div> : null; })}</div> : <div className="shared-empty"><div className="shared-icon"><Headphones size={17}/></div><p>Your calls together<br/>will show up here.</p></div>}</div><div className="details-bottom"><span><ShieldCheck size={14}/> PRIVATE CONVERSATION</span></div></> : <div className="details-quiet"><div className="quiet-line"/><p>Your closest circles,<br/>without the noise.</p><span>MESSAGES / CALLS / PEOPLE</span></div>}
      </aside>
      {call && !call.groupCall && <div className="call-overlay" role="dialog" aria-modal="true" aria-label={`${call.mode} call`}><div className={`call-window ${call.mode === 'video' ? 'video-call-window' : ''}`}><button className="icon-button call-close" onClick={() => finishCall(true)} title="End call"><X size={18}/></button>{call.mode === 'video' ? <div className="video-stage"><video ref={remoteVideo} autoPlay playsInline/><video ref={localVideo} autoPlay muted playsInline className="local-video"/>{call.phase !== 'active' && <div className="video-placeholder"><div className="avatar call-avatar">{initials(call.peer.name)}</div><span>{call.phase === 'incoming' ? 'Incoming video call' : 'Connecting video…'}</span></div>}</div> : <div className="call-orbit"><div className="avatar call-avatar">{initials(call.peer.name)}</div><span className="call-pulse"/></div>}<span className="call-label">{call.mode === 'video' ? 'VIDEO CALL' : call.phase === 'incoming' ? 'INCOMING VOICE CALL' : call.phase === 'outgoing' ? 'REACHING OUT' : 'VOICE CONNECTION'}</span><h2>{call.peer.name}</h2><p>{call.phase === 'incoming' ? `is calling you${call.mode === 'video' ? ' with video' : ''}` : call.phase === 'outgoing' ? 'Waiting for them to pick up…' : 'You’re connected'}</p>{call.mode === 'audio' && <div className="call-wave"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div>}<div className="call-controls">{call.phase === 'incoming' ? <><button className="decline-call" title="Decline call" onClick={() => finishCall(true)}><Phone size={18}/></button><button className="accept-call" title="Accept call" onClick={acceptCall}><Phone size={18}/></button></> : <>{call.mode === 'video' && <button className={`mute-call ${cameraOff ? 'is-muted' : ''}`} title={cameraOff ? 'Turn camera on' : 'Turn camera off'} onClick={toggleCamera}>{cameraOff ? <VideoOff size={19}/> : <Video size={19}/>}</button>}<button className={`mute-call ${muted ? 'is-muted' : ''}`} title={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={toggleMute}>{muted ? <MicOff size={19}/> : <Mic size={19}/>}</button><button className="decline-call" title="End call" onClick={() => finishCall(true)}><Phone size={18}/></button></>}</div><span className="call-encryption"><ShieldCheck size={13}/> PEER-TO-PEER {call.mode === 'video' ? 'VIDEO' : 'AUDIO'}</span></div></div>}
      {call?.groupCall && <div className="call-overlay" role="dialog" aria-modal="true" aria-label="Group video call"><div className="group-video-window"><header><div><span className="call-label">GROUP VIDEO CHAT</span><h2>{call.groupCall.name}</h2><p>{call.phase === 'incoming' ? `${call.peer.name} invited you` : 'Video is hosted by Jitsi Meet'}</p></div><button className="icon-button" onClick={() => call.phase === 'incoming' ? setCall(null) : finishCall(true)} title={call.phase === 'incoming' ? 'Decline invite' : 'Leave group call'}><X size={18}/></button></header>{call.phase === 'incoming' ? <div className="group-call-invite"><div className="avatar call-avatar">{initials(call.peer.name)}</div><button className="decline-call" title="Decline group call" onClick={() => setCall(null)}><Phone size={18}/></button><button className="accept-call" title="Join group call" onClick={acceptCall}><Video size={18}/></button></div> : <iframe className="group-video-frame" title={`Group call: ${call.groupCall.name}`} src={`https://meet.jit.si/${call.groupCall.roomId}#userInfo.displayName=${encodeURIComponent(me.name)}&config.prejoinPageEnabled=false`} allow="camera; microphone; fullscreen; display-capture; autoplay" referrerPolicy="no-referrer"/>}<span className="call-encryption">GROUP VIDEO HOSTED BY JITSI MEET. ANYONE WITH THE ROOM LINK MAY JOIN.</span></div></div>}
      <audio ref={remoteAudio} autoPlay/>
      {groupModal && <div className="call-overlay" role="dialog" aria-modal="true" aria-label="Create group chat"><form className="group-modal" onSubmit={createGroup}><button type="button" className="icon-button call-close" onClick={() => setGroupModal(false)} title="Close"><X size={18}/></button><span className="section-label">MAKE A LITTLE ROOM</span><h2>New group</h2><label className="group-name-label">Group name<input value={groupName} onChange={(event) => setGroupName(event.target.value)} minLength={2} maxLength={60} placeholder="Sunday crew" required/></label><div className="group-picker-label">Add people <span>{groupMembers.length} selected</span></div><div className="group-picker">{people.map((person) => <label className="group-option" key={person.id}><input type="checkbox" checked={groupMembers.includes(person.id)} onChange={(event) => setGroupMembers((current) => event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id))}/><span className="avatar">{initials(person.name)}</span><span>{person.name}</span><small>{person.email}</small></label>)}</div><button className="primary-button group-submit" disabled={groupName.trim().length < 2 || groupMembers.length === 0}>Create group <ArrowUpRight size={17}/></button></form></div>}
      {authError && me && <div className="toast" role="status">{authError}<button onClick={() => setAuthError('')} aria-label="Dismiss"><X size={15}/></button></div>}
    </main>
  );
}
