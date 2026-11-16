(() => {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const APP_NAME = 'Апельсин';
  const BUCKET = 'chat-files';
  const PAGE = 40;
  const MAX_FILE = 25 * 1024 * 1024;
  const AVATAR_COLORS = ['#e8590c', '#2f9e44', '#1971c2', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5f3dc4'];

  const $ = (id) => document.getElementById(id);

  // Собирает DOM-узел. Текст всегда вставляется как текст, поэтому чужие сообщения не могут подсунуть разметку.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') el.style.cssText = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) el.append(kid);
    }
    return el;
  }

  const ICONS = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5"/></svg>',
  };
  function icon(name) {
    const span = h('span', { class: 'ico' });
    span.innerHTML = ICONS[name];
    return span;
  }

  const state = {
    me: null,
    profiles: new Map(),
    chats: [],
    chatId: null,
    messages: [],
    hasMore: false,
    loadingMore: false,
    online: new Set(),
    search: '',
    drafts: new Map(),
    pushOn: false,
    pushFailures: 0,
  };

  let sb = null;
  let dbChannel = null;
  let presenceChannel = null;
  let heartbeatTimer = null;
  let wasSubscribed = false;
  let startedFor = null;
  let swReady = null;

  // ───────────────────────── Мелкие помощники ─────────────────────────

  function show(sectionId) {
    for (const id of ['setup', 'auth', 'blocked', 'main']) $(id).hidden = id !== sectionId;
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    // Поповер поднимает подсказку поверх открытых окон.
    if (el.showPopover) {
      try { el.hidePopover(); } catch (error) { /* не был открыт */ }
      try { el.showPopover(); } catch (error) { /* покажется обычным блоком */ }
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      try { el.hidePopover(); } catch (error) { /* уже закрыт */ }
      el.hidden = true;
    }, 3500);
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  const timeFmt = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });
  const dayYearFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' });
  const shortFmt = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit' });

  function dayKey(date) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }
  function daysAgo(date) {
    const today = new Date();
    const a = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const b = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((a - b) / 86400000);
  }
  function dayLabel(date) {
    const ago = daysAgo(date);
    if (ago === 0) return 'Сегодня';
    if (ago === 1) return 'Вчера';
    return date.getFullYear() === new Date().getFullYear() ? dayFmt.format(date) : dayYearFmt.format(date);
  }
  function listTime(iso) {
    const date = new Date(iso);
    const ago = daysAgo(date);
    if (ago === 0) return timeFmt.format(date);
    if (ago === 1) return 'вчера';
    return shortFmt.format(date);
  }
  function lastSeenText(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const ago = daysAgo(date);
    if (ago === 0) return `в сети был(а) сегодня в ${timeFmt.format(date)}`;
    if (ago === 1) return `в сети был(а) вчера в ${timeFmt.format(date)}`;
    return `в сети был(а) ${dayFmt.format(date)}`;
  }
  function plural(n, one, few, many) {
    const d = n % 10, dd = n % 100;
    if (d === 1 && dd !== 11) return one;
    if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
    return many;
  }
  function fileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  function colorFor(id) {
    let sum = 0;
    for (const ch of String(id)) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[sum % AVATAR_COLORS.length];
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
    return letters.toUpperCase();
  }
  function avatar(id, name, { group = false, online = false, small = false } = {}) {
    return h('span', {
      class: `avatar${group ? ' group' : ''}${small ? ' small' : ''}${online ? ' online' : ''}`,
      style: `background:${colorFor(id)}`,
      'aria-hidden': 'true',
    }, initials(name));
  }

  function linkify(text) {
    const out = [];
    const re = /https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g;
    let last = 0, match;
    while ((match = re.exec(text))) {
      if (match.index > last) out.push(text.slice(last, match.index));
      out.push(h('a', { href: match[0], target: '_blank', rel: 'noopener noreferrer' }, match[0]));
      last = match.index + match[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
  const isLooking = () => document.visibilityState === 'visible' && document.hasFocus();

  // ───────────────────────── Вход и регистрация ─────────────────────────

  let authMode = 'login';
  let needsInvite = true;

  async function setAuthMode(mode) {
    authMode = mode;
    const register = mode === 'register';
    $('auth-title').textContent = register ? 'Регистрация' : 'Вход';
    $('auth-submit').textContent = register ? 'Создать аккаунт' : 'Войти';
    $('auth-switch').textContent = register ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
    $('auth-name-field').hidden = !register;
    $('auth-name').required = register;
    $('auth-password').autocomplete = register ? 'new-password' : 'current-password';
    $('auth-error').hidden = true;
    $('auth-invite-field').hidden = true;
    $('auth-first').hidden = true;
    if (!register) return;

    const { data, error } = await sb.rpc('needs_invite');
    if (authMode !== 'register') return;
    needsInvite = error ? true : data;
    $('auth-invite-field').hidden = !needsInvite;
    $('auth-invite').required = needsInvite;
    $('auth-first').hidden = needsInvite;
  }

  function authError(error) {
    const text = String((error && error.message) || error || '');
    let message = text || 'Что-то пошло не так. Попробуй ещё раз.';
    if (/Invalid login credentials/i.test(text)) message = 'Неверная почта или пароль.';
    else if (/already registered|already been registered/i.test(text)) message = 'Такая почта уже зарегистрирована. Попробуй войти.';
    else if (/Database error saving new user|INVITE_INVALID/i.test(text)) message = 'Код приглашения не подошёл.';
    else if (/Password should be at least/i.test(text)) message = 'Пароль слишком короткий: нужно минимум 6 символов.';
    else if (/invalid.*email|email.*invalid/i.test(text)) message = 'Почта введена с ошибкой.';
    else if (/rate limit|too many/i.test(text)) message = 'Слишком много попыток. Подожди минуту и попробуй снова.';
    else if (/Failed to fetch|NetworkError|Load failed/i.test(text)) message = 'Нет связи с сервером. Проверь интернет.';
    $('auth-error').textContent = message;
    $('auth-error').hidden = false;
  }

  async function submitAuth(event) {
    event.preventDefault();
    const button = $('auth-submit');
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    $('auth-error').hidden = true;
    button.disabled = true;
    try {
      if (authMode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return;
      }
      const name = $('auth-name').value.trim();
      const invite = $('auth-invite').value.trim();
      if (!name) throw new Error('Напиши имя и фамилию, чтобы коллеги тебя узнали.');
      if (needsInvite) {
        const { data: valid, error } = await sb.rpc('check_invite', { p_code: invite });
        if (error) throw error;
        if (!valid) throw new Error('INVITE_INVALID');
      }
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name, invite } } });
      if (error) throw error;
      if (!data.session) {
        throw new Error('Аккаунт создан, но Supabase ждёт подтверждения почты. Администратору нужно выключить «Confirm email» в настройках Supabase.');
      }
    } catch (error) {
      authError(error);
    } finally {
      button.disabled = false;
    }
  }

  async function logout() {
    try {
      if (swReady) {
        const reg = await swReady;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sb.rpc('delete_push', { p_endpoint: sub.endpoint });
          await sub.unsubscribe();
        }
      }
    } catch (error) { /* выход важнее отписки */ }
    await sb.auth.signOut();
  }

  // ───────────────────────── Загрузка данных ─────────────────────────

  async function loadProfiles() {
    const { data, error } = await sb.from('profiles').select('id, name, department, position, is_admin, blocked, last_seen');
    if (error) throw error;
    state.profiles = new Map(data.map((p) => [p.id, p]));
  }

  async function loadChats() {
    const { data, error } = await sb.rpc('my_chats');
    if (error) throw error;
    state.chats = data || [];
  }

  let reloadTimer = null;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try {
        await loadChats();
      } catch (error) { return; }
      if (state.chatId && !findChat(state.chatId)) closeChat();
      renderChatList();
      renderChatHeader();
      updateTicks();
    }, 300);
  }

  const findChat = (id) => state.chats.find((c) => c.id === id);
  const profile = (id) => state.profiles.get(id);
  const nameOf = (id) => (profile(id) ? profile(id).name : 'Бывший сотрудник');

  function chatPeer(chat) {
    if (chat.is_group) return null;
    const other = (chat.members || []).find((m) => m.user_id !== state.me.id);
    return other ? profile(other.user_id) || { id: other.user_id, name: 'Бывший сотрудник' } : null;
  }
  function chatTitle(chat) {
    if (chat.is_group) return chat.title || 'Группа';
    const peer = chatPeer(chat);
    return peer ? peer.name : 'Бывший сотрудник';
  }
  function chatAvatar(chat, small) {
    if (chat.is_group) return avatar(chat.id, chat.title, { group: true, small });
    const peer = chatPeer(chat);
    return avatar(peer ? peer.id : chat.id, chatTitle(chat), { small, online: !!peer && state.online.has(peer.id) });
  }
  function previewText(message) {
    if (!message) return '';
    if (message.body) return message.body;
    if ((message.file_type || '').startsWith('image/')) return '📷 Фото';
    return '📎 ' + (message.file_name || 'Файл');
  }

  // ───────────────────────── Список чатов ─────────────────────────

  function renderMe() {
    $('me-btn').replaceChildren(avatar(state.me.id, state.me.name, { small: true }));
  }

  function renderChatList() {
    if (!state.me) return;
    const query = state.search.trim().toLowerCase();
    const rows = state.chats
      .filter((chat) => chat.is_group || chat.last_message || chat.id === state.chatId)
      .filter((chat) => !query || chatTitle(chat).toLowerCase().includes(query))
      .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))
      .map((chat) => {
        const last = chat.last_message;
        let prefix = '';
        if (last && last.sender_id === state.me.id) prefix = 'Ты: ';
        else if (last && chat.is_group) prefix = nameOf(last.sender_id).split(' ')[0] + ': ';
        return h('button', {
          class: `row${chat.id === state.chatId ? ' active' : ''}`,
          type: 'button',
          onclick: () => openChat(chat.id),
        },
          chatAvatar(chat),
          h('span', { class: 'row-main' },
            h('span', { class: 'row-top' },
              h('strong', null, chatTitle(chat)),
              last && h('time', null, listTime(last.created_at))),
            h('span', { class: 'row-bottom' },
              h('span', { class: 'preview' }, last ? prefix + previewText(last) : 'Сообщений пока нет'),
              chat.unread > 0 && h('span', { class: 'badge' }, String(chat.unread)))));
      });

    const list = $('chat-list');
    if (rows.length) {
      list.replaceChildren(...rows);
    } else {
      list.replaceChildren(h('p', { class: 'list-empty' },
        query ? 'Ничего не найдено' : 'Чатов пока нет. Нажми «+», чтобы написать коллеге.'));
    }
    updateBadge();
  }

  function updateBadge() {
    const total = state.chats.reduce((sum, chat) => sum + (Number(chat.unread) || 0), 0);
    document.title = total ? `(${total}) ${APP_NAME}` : APP_NAME;
    if (navigator.setAppBadge) {
      (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
    }
  }

  // ───────────────────────── Открытый чат ─────────────────────────

  function renderChatHeader() {
    const chat = state.chatId && findChat(state.chatId);
    if (!chat) return;
    $('chat-avatar').replaceChildren(chatAvatar(chat, true));
    $('chat-title').textContent = chatTitle(chat);
    let status = '';
    if (chat.is_group) {
      const members = chat.members || [];
      const online = members.filter((m) => state.online.has(m.user_id)).length;
      status = `${members.length} ${plural(members.length, 'участник', 'участника', 'участников')}`;
      if (online > 1) status += `, ${online} в сети`;
    } else {
      const peer = chatPeer(chat);
      if (peer && state.online.has(peer.id)) status = 'в сети';
      else if (peer) status = lastSeenText(peer.last_seen) || [peer.position, peer.department].filter(Boolean).join(', ');
    }
    $('chat-status').textContent = status;
    $('chat-status').classList.toggle('online', status === 'в сети');
  }

  async function openChat(id) {
    const chat = findChat(id);
    if (!chat) return;
    if (state.chatId && state.chatId !== id) state.drafts.set(state.chatId, $('message-input').value);

    const wasOpen = !!state.chatId;
    state.chatId = id;
    state.messages = [];
    state.hasMore = false;
    $('main').classList.add('open');
    $('chat-empty').hidden = true;
    $('chat-body').hidden = false;
    $('message-input').value = state.drafts.get(id) || '';
    autosize();
    renderChatHeader();
    renderChatList();
    $('messages').replaceChildren(h('p', { class: 'messages-note' }, 'Загрузка…'));

    if (wasOpen) history.replaceState({ chat: id }, '');
    else history.pushState({ chat: id }, '');

    const { data, error } = await sb.from('messages').select('*')
      .eq('chat_id', id).order('created_at', { ascending: false }).limit(PAGE);
    if (state.chatId !== id) return;
    if (error) {
      $('messages').replaceChildren(h('p', { class: 'messages-note' }, 'Не получилось загрузить сообщения. Проверь интернет.'));
      return;
    }
    const pending = state.messages.filter((m) => m.pending || m.failed);
    state.messages = data.reverse().concat(pending);
    state.hasMore = data.length === PAGE;
    renderMessages();
    scrollToBottom();
    markRead();
    if (!isTouch()) $('message-input').focus();
  }

  function closeChat() {
    if (state.chatId) state.drafts.set(state.chatId, $('message-input').value);
    state.chatId = null;
    state.messages = [];
    $('main').classList.remove('open');
    $('chat-body').hidden = true;
    $('chat-empty').hidden = false;
    renderChatList();
  }

  function isReadByOthers(message, chat) {
    const at = new Date(message.created_at);
    return (chat.members || []).some((m) => m.user_id !== state.me.id && new Date(m.last_read_at) >= at);
  }

  function messageEl(message, prev, chat) {
    const own = message.sender_id === state.me.id;
    const firstOfRun = !prev || prev.sender_id !== message.sender_id
      || dayKey(new Date(prev.created_at)) !== dayKey(new Date(message.created_at));
    const bubble = h('div', { class: 'bubble' });

    if (chat.is_group && !own && firstOfRun) {
      bubble.append(h('div', { class: 'sender', style: `color:${colorFor(message.sender_id || '')}` }, nameOf(message.sender_id)));
    }

    if (message.file_path || message.localUrl) {
      if ((message.file_type || '').startsWith('image/')) {
        const img = h('img', { class: 'photo', alt: message.file_name || 'Фото', loading: 'lazy' });
        img.addEventListener('load', () => { if (stickToBottom) scrollToBottom(); });
        img.addEventListener('click', () => openViewer(img.src, message));
        if (message.localUrl) img.src = message.localUrl;
        else signedUrl(message.file_path).then((url) => { img.src = url; }).catch(() => { img.alt = 'Фото не загрузилось'; });
        bubble.append(img);
      } else {
        bubble.append(h('button', {
          class: 'file', type: 'button',
          onclick: () => downloadFile(message),
        },
          icon('file'),
          h('span', { class: 'file-text' },
            h('strong', null, message.file_name || 'Файл'),
            h('small', null, fileSize(message.file_size)))));
      }
    }

    if (message.body) bubble.append(h('div', { class: 'text' }, linkify(message.body)));

    const meta = h('span', { class: 'meta' });
    if (message.failed) meta.append('не отправлено · повторить');
    else if (message.pending) meta.append(message.file_name ? 'загрузка…' : 'отправка…');
    else {
      meta.append(timeFmt.format(new Date(message.created_at)));
      if (own) meta.append(h('span', { class: 'tick' }, isReadByOthers(message, chat) ? '✓✓' : '✓'));
    }
    bubble.append(meta);

    const el = h('div', {
      class: `msg ${own ? 'own' : 'other'}${firstOfRun ? ' first' : ''}${message.failed ? ' failed' : ''}`,
      'data-id': message.id,
    }, bubble);
    if (message.failed) bubble.addEventListener('click', () => retry(message));
    return el;
  }

  function renderMessages() {
    const chat = findChat(state.chatId);
    const box = $('messages');
    if (!chat) return;
    const nodes = [];
    if (state.hasMore) nodes.push(h('p', { class: 'messages-note' }, 'Прокрути вверх, чтобы увидеть раньше'));
    let prev = null;
    for (const message of state.messages) {
      const date = new Date(message.created_at);
      if (!prev || dayKey(new Date(prev.created_at)) !== dayKey(date)) {
        nodes.push(h('div', { class: 'day' }, h('span', null, dayLabel(date))));
      }
      nodes.push(messageEl(message, prev, chat));
      prev = message;
    }
    if (!state.messages.length) nodes.push(h('p', { class: 'messages-note' }, 'Здесь пока пусто. Напиши первым.'));
    box.replaceChildren(...nodes);
  }

  function updateTicks() {
    const chat = state.chatId && findChat(state.chatId);
    if (!chat) return;
    for (const message of state.messages) {
      if (message.sender_id !== state.me.id || message.pending || message.failed) continue;
      const tick = $('messages').querySelector(`[data-id="${message.id}"] .tick`);
      if (tick) tick.textContent = isReadByOthers(message, chat) ? '✓✓' : '✓';
    }
  }

  let stickToBottom = true;
  function scrollToBottom() {
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
    stickToBottom = true;
  }

  async function loadOlder() {
    if (!state.hasMore || state.loadingMore || !state.chatId) return;
    const first = state.messages.find((m) => !m.pending && !m.failed);
    if (!first) return;
    state.loadingMore = true;
    const id = state.chatId;
    const { data, error } = await sb.from('messages').select('*')
      .eq('chat_id', id).lt('created_at', first.created_at)
      .order('created_at', { ascending: false }).limit(PAGE);
    state.loadingMore = false;
    if (error || state.chatId !== id) return;
    const box = $('messages');
    const before = box.scrollHeight - box.scrollTop;
    state.messages = data.reverse().concat(state.messages);
    state.hasMore = data.length === PAGE;
    renderMessages();
    box.scrollTop = box.scrollHeight - before;
  }

  // Добавляет или обновляет сообщение в открытом чате.
  function upsertMessage(message) {
    if (message.chat_id !== state.chatId) return;
    const at = state.messages.findIndex((m) => m.id === message.id);
    const keepDown = stickToBottom;
    if (at >= 0) {
      const old = state.messages[at];
      if (old.localUrl && !message.localUrl) message.localUrl = old.localUrl;
      state.messages[at] = message;
    } else {
      state.messages.push(message);
    }
    renderMessages();
    if (keepDown || message.sender_id === state.me.id) scrollToBottom();
  }

  let readTimer = null;
  function markRead() {
    const id = state.chatId;
    const chat = id && findChat(id);
    if (!chat || !isLooking()) return;
    if (chat.unread > 0) {
      chat.unread = 0;
      renderChatList();
    }
    clearTimeout(readTimer);
    readTimer = setTimeout(() => { sb.rpc('mark_read', { p_chat: id }).then(() => {}); }, 250);
  }

  // ───────────────────────── Отправка ─────────────────────────

  function touchChat(message) {
    const chat = findChat(message.chat_id);
    if (!chat) return;
    chat.last_message = message;
    chat.last_message_at = message.created_at;
    renderChatList();
  }

  // prepare: необязательный шаг перед записью сообщения (загрузка файла).
  async function deliver(message, prepare) {
    message.pending = true;
    message.failed = false;
    message.prepare = prepare;
    upsertMessage(message);
    touchChat(message);
    try {
      if (prepare) await prepare();
      const { data, error } = await sb.from('messages').insert({
        id: message.id,
        chat_id: message.chat_id,
        body: message.body || '',
        file_path: message.file_path || null,
        file_name: message.file_name || null,
        file_type: message.file_type || null,
        file_size: message.file_size || null,
      }).select().single();
      if (error) throw error;
      upsertMessage(data);
      touchChat(data);
      notifyPush(data.id);
    } catch (error) {
      message.pending = false;
      message.failed = true;
      upsertMessage(message);
      toast('Сообщение не отправилось. Нажми на него, чтобы повторить.');
    }
  }

  function retry(message) {
    if (!message.failed) return;
    deliver(message, message.prepare);
  }

  function newMessage(fields) {
    return {
      id: uuid(),
      chat_id: state.chatId,
      sender_id: state.me.id,
      body: '',
      created_at: new Date().toISOString(),
      ...fields,
    };
  }

  function sendText() {
    const input = $('message-input');
    const text = input.value.trim();
    if (!text || !state.chatId) return;
    input.value = '';
    state.drafts.delete(state.chatId);
    autosize();
    deliver(newMessage({ body: text }));
    if (!isTouch()) input.focus();
  }

  // Большие фото уменьшаются перед загрузкой: так они быстрее уходят и не съедают место в хранилище.
  async function shrinkImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const longest = Math.max(bitmap.width, bitmap.height);
      if (longest <= 1920 && file.size <= 700 * 1024) return file;
      const scale = Math.min(1, 1920 / longest);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
      return new File([blob], name, { type: 'image/jpeg' });
    } catch (error) {
      return file;
    }
  }

  async function sendFiles(fileList) {
    const files = [...fileList];
    if (!files.length || !state.chatId) return;
    const input = $('message-input');
    let caption = input.value.trim();
    input.value = '';
    autosize();

    for (const original of files) {
      if (original.size > MAX_FILE) {
        toast(`«${original.name}» больше 25 МБ, такой файл не отправить.`);
        continue;
      }
      const file = await shrinkImage(original);
      const type = file.type || 'application/octet-stream';
      const ext = (/\.([a-z0-9]{1,8})$/i.exec(file.name || '') || [])[1];
      const message = newMessage({
        body: caption,
        file_name: (file.name || 'file').slice(0, 200),
        file_type: type,
        file_size: file.size,
      });
      caption = '';
      const path = `${message.chat_id}/${message.id}${ext ? '.' + ext.toLowerCase() : ''}`;
      if (type.startsWith('image/')) message.localUrl = URL.createObjectURL(file);

      let uploaded = false;
      deliver(message, async () => {
        if (uploaded) return;
        const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: type, upsert: false });
        if (error && !/exists/i.test(error.message || '')) throw error;
        uploaded = true;
        message.file_path = path;
      });
    }
  }

  // ───────────────────────── Файлы: ссылки и просмотр ─────────────────────────

  const urlCache = new Map();
  let urlQueue = new Map();
  let urlTimer = null;

  // Ссылки на файлы временные. Запросы за ними собираются в пачку, чтобы не дёргать сервер по одной картинке.
  function signedUrl(path) {
    const cached = urlCache.get(path);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.url);
    let entry = urlQueue.get(path);
    if (!entry) {
      entry = {};
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      urlQueue.set(path, entry);
      clearTimeout(urlTimer);
      urlTimer = setTimeout(flushUrls, 20);
    }
    return entry.promise;
  }

  async function flushUrls() {
    const batch = urlQueue;
    urlQueue = new Map();
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls([...batch.keys()], 6 * 3600);
    for (const [path, entry] of batch) {
      const row = !error && (data || []).find((item) => item.path === path);
      if (row && row.signedUrl) {
        urlCache.set(path, { url: row.signedUrl, expires: Date.now() + 5 * 3600 * 1000 });
        entry.resolve(row.signedUrl);
      } else {
        entry.reject(new Error('no url'));
      }
    }
  }

  // Файл скачивается через память браузера: только так имя с русскими буквами остаётся как было.
  async function downloadFile(message) {
    if (!message.file_path) return;
    toast('Скачиваю…');
    const { data: blob, error } = await sb.storage.from(BUCKET).download(message.file_path);
    if (error || !blob) return toast('Не получилось скачать файл.');
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: message.file_name || 'file' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function openViewer(src, message) {
    const viewer = $('viewer');
    viewer.replaceChildren(
      h('img', { src, alt: message.file_name || 'Фото' }),
      h('div', { class: 'viewer-bar' },
        message.file_path && h('button', { class: 'btn', type: 'button', onclick: () => downloadFile(message) }, 'Скачать'),
        h('button', { class: 'btn', type: 'button', onclick: () => viewer.close() }, 'Закрыть')));
    viewer.showModal();
  }

  // ───────────────────────── Действия с сообщением ─────────────────────────

  function messageMenu(message) {
    if (message.pending || message.failed) return;
    const own = message.sender_id === state.me.id;
    const items = [];
    if (message.body) {
      items.push(h('button', {
        class: 'btn wide', type: 'button',
        onclick: async () => {
          try { await navigator.clipboard.writeText(message.body); toast('Скопировано'); } catch (error) { toast('Не получилось скопировать'); }
          closeModal();
        },
      }, 'Скопировать текст'));
    }
    if (own) {
      items.push(h('button', {
        class: 'btn wide danger', type: 'button',
        onclick: async () => {
          closeModal();
          const { error } = await sb.from('messages').delete().eq('id', message.id);
          if (error) return toast('Не получилось удалить.');
          removeMessage(message.id);
        },
      }, 'Удалить у всех'));
    }
    if (!items.length) return;
    openModal('Сообщение', h('div', { class: 'stack' }, items));
  }

  function removeMessage(id) {
    const before = state.messages.length;
    state.messages = state.messages.filter((m) => m.id !== id);
    if (state.messages.length !== before) renderMessages();
    scheduleReload();
  }

  // ───────────────────────── Окна ─────────────────────────

  function openModal(title, content) {
    const modal = $('modal');
    const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрыть', onclick: closeModal });
    close.innerHTML = ICONS.close;
    modal.replaceChildren(
      h('header', { class: 'modal-head' }, h('h3', null, title), close),
      h('div', { class: 'modal-body' }, content));
    if (!modal.open) modal.showModal();
  }
  function closeModal() {
    if ($('modal').open) $('modal').close();
  }

  // Список сотрудников по отделам. multi: выбор нескольких галочками, иначе нажатие сразу выбирает одного.
  function peoplePicker({ multi = false, exclude = [], onPick, onChange }) {
    const selected = new Set();
    const hidden = new Set([state.me.id, ...exclude]);
    const listEl = h('div', { class: 'people' });
    const search = h('input', { type: 'search', placeholder: 'Поиск по имени, отделу, должности', 'aria-label': 'Поиск сотрудника' });

    function draw() {
      const query = search.value.trim().toLowerCase();
      const people = [...state.profiles.values()]
        .filter((p) => !p.blocked && !hidden.has(p.id))
        .filter((p) => !query || `${p.name} ${p.department} ${p.position}`.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      const groups = new Map();
      for (const person of people) {
        const key = person.department || 'Без отдела';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(person);
      }
      const names = [...groups.keys()].sort((a, b) =>
        (a === 'Без отдела') - (b === 'Без отдела') || a.localeCompare(b, 'ru'));
      const nodes = [];
      for (const name of names) {
        if (names.length > 1 || name !== 'Без отдела') nodes.push(h('div', { class: 'people-group' }, name));
        for (const person of groups.get(name)) {
          const row = h('button', {
            class: `row${selected.has(person.id) ? ' picked' : ''}`,
            type: 'button',
            'aria-pressed': multi ? String(selected.has(person.id)) : null,
            onclick: () => {
              if (!multi) return onPick(person);
              if (selected.has(person.id)) selected.delete(person.id);
              else selected.add(person.id);
              draw();
              if (onChange) onChange(selected);
            },
          },
            avatar(person.id, person.name, { online: state.online.has(person.id) }),
            h('span', { class: 'row-main' },
              h('strong', null, person.name),
              h('span', { class: 'preview' }, person.position || (state.online.has(person.id) ? 'в сети' : ''))),
            multi && h('span', { class: 'check', 'aria-hidden': 'true' }, selected.has(person.id) ? '✓' : ''));
          nodes.push(row);
        }
      }
      if (!nodes.length) nodes.push(h('p', { class: 'list-empty' }, query ? 'Никого не нашлось' : 'Пока никого нет. Пригласи коллег: код приглашения есть у администратора в настройках.'));
      listEl.replaceChildren(...nodes);
    }
    search.addEventListener('input', draw);
    draw();
    return { el: h('div', { class: 'picker' }, search, listEl), selected };
  }

  async function startDirect(person) {
    closeModal();
    const { data: id, error } = await sb.rpc('start_direct', { p_other: person.id });
    if (error) return toast('Не получилось открыть чат.');
    if (!findChat(id)) await loadChats();
    openChat(id);
  }

  // Список коллег перечитывается при каждом открытии: так новичок виден сразу, даже если живое обновление не дошло.
  const refreshProfiles = () => loadProfiles().catch(() => {});

  async function newChatModal() {
    await refreshProfiles();
    const picker = peoplePicker({ onPick: startDirect });
    openModal('Новый чат', h('div', { class: 'stack' },
      h('button', { class: 'btn wide', type: 'button', onclick: newGroupModal }, 'Создать группу'),
      picker.el));
  }

  function newGroupModal() {
    const title = h('input', { type: 'text', maxlength: '80', placeholder: 'Название группы', 'aria-label': 'Название группы' });
    const create = h('button', { class: 'btn primary wide', type: 'button' }, 'Создать группу');
    const picker = peoplePicker({
      multi: true,
      onChange: (selected) => { create.textContent = selected.size ? `Создать группу (${selected.size + 1})` : 'Создать группу'; },
    });
    create.addEventListener('click', async () => {
      if (!title.value.trim()) { title.focus(); return toast('Придумай название группы.'); }
      create.disabled = true;
      const { data: id, error } = await sb.rpc('create_group', { p_title: title.value, p_members: [...picker.selected] });
      create.disabled = false;
      if (error) return toast('Не получилось создать группу.');
      closeModal();
      await loadChats();
      openChat(id);
    });
    openModal('Новая группа', h('div', { class: 'stack' }, title, picker.el, create));
    title.focus();
  }

  function chatInfoModal() {
    const chat = state.chatId && findChat(state.chatId);
    if (!chat) return;

    if (!chat.is_group) {
      const peer = chatPeer(chat);
      if (!peer) return;
      const online = state.online.has(peer.id);
      openModal('Профиль', h('div', { class: 'stack center-text' },
        avatar(peer.id, peer.name),
        h('h3', null, peer.name),
        h('p', { class: 'muted' }, [peer.position, peer.department].filter(Boolean).join(', ') || 'Отдел не указан'),
        h('p', { class: 'muted' }, online ? 'в сети' : lastSeenText(peer.last_seen))));
      return;
    }

    const mine = (chat.members || []).find((m) => m.user_id === state.me.id);
    const owner = !!(mine && mine.is_owner);
    const body = h('div', { class: 'stack' });

    if (owner) {
      const title = h('input', { type: 'text', maxlength: '80', value: chat.title || '', 'aria-label': 'Название группы' });
      body.append(h('div', { class: 'inline' }, title, h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          const { error } = await sb.rpc('rename_chat', { p_chat: chat.id, p_title: title.value });
          if (error) return toast('Не получилось переименовать.');
          chat.title = title.value.trim();
          renderChatList();
          renderChatHeader();
          toast('Название обновлено');
        },
      }, 'Сохранить')));
    }

    body.append(h('button', {
      class: 'btn wide', type: 'button',
      onclick: () => addMembersModal(chat),
    }, 'Добавить участников'));

    const members = (chat.members || []).slice().sort((a, b) =>
      b.is_owner - a.is_owner || nameOf(a.user_id).localeCompare(nameOf(b.user_id), 'ru'));
    body.append(h('div', { class: 'people' }, members.map((member) => {
      const person = profile(member.user_id) || { id: member.user_id, name: 'Бывший сотрудник' };
      return h('div', { class: 'row static' },
        avatar(person.id, person.name, { online: state.online.has(person.id) }),
        h('span', { class: 'row-main' },
          h('strong', null, person.name + (person.id === state.me.id ? ' (ты)' : '')),
          h('span', { class: 'preview' }, member.is_owner ? 'создатель группы' : (person.position || ''))),
        owner && person.id !== state.me.id && h('button', {
          class: 'btn small', type: 'button',
          onclick: async () => {
            const { error } = await sb.rpc('remove_member', { p_chat: chat.id, p_user: person.id });
            if (error) return toast('Не получилось убрать участника.');
            await loadChats();
            renderChatHeader();
            chatInfoModal();
          },
        }, 'Убрать'));
    })));

    body.append(h('button', {
      class: 'btn wide danger', type: 'button',
      onclick: async () => {
        if (!confirm('Выйти из группы? Переписка у тебя пропадёт.')) return;
        const { error } = await sb.rpc('remove_member', { p_chat: chat.id, p_user: state.me.id });
        if (error) return toast('Не получилось выйти.');
        closeModal();
        closeChat();
        await loadChats();
        renderChatList();
      },
    }, 'Выйти из группы'));

    openModal(chat.title || 'Группа', body);
  }

  async function addMembersModal(chat) {
    await refreshProfiles();
    const add = h('button', { class: 'btn primary wide', type: 'button' }, 'Добавить');
    const picker = peoplePicker({ multi: true, exclude: (chat.members || []).map((m) => m.user_id) });
    add.addEventListener('click', async () => {
      if (!picker.selected.size) return toast('Отметь, кого добавить.');
      const { error } = await sb.rpc('add_members', { p_chat: chat.id, p_members: [...picker.selected] });
      if (error) return toast('Не получилось добавить.');
      await loadChats();
      renderChatHeader();
      chatInfoModal();
    });
    openModal('Добавить участников', h('div', { class: 'stack' }, picker.el, add));
  }

  // ───────────────────────── Настройки ─────────────────────────

  function pushStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return isIOS && !isStandalone() ? 'ios-install' : 'unsupported';
    }
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission === 'granted' && state.pushOn) return 'on';
    return 'off';
  }

  async function settingsModal() {
    const me = state.me;
    await refreshProfiles();
    const body = h('div', { class: 'stack' });

    // Профиль
    const name = h('input', { type: 'text', maxlength: '60', value: me.name, 'aria-label': 'Имя и фамилия' });
    const departments = [...new Set([...state.profiles.values()].map((p) => p.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    const department = h('input', { type: 'text', maxlength: '60', value: me.department, list: 'departments', placeholder: 'Например: Склад' });
    const position = h('input', { type: 'text', maxlength: '60', value: me.position, placeholder: 'Например: Продавец' });
    body.append(
      h('h4', null, 'Профиль'),
      h('label', { class: 'field' }, h('span', null, 'Имя и фамилия'), name),
      h('label', { class: 'field' }, h('span', null, 'Отдел'), department),
      h('datalist', { id: 'departments' }, departments.map((d) => h('option', { value: d }))),
      h('label', { class: 'field' }, h('span', null, 'Должность'), position),
      h('button', {
        class: 'btn primary wide', type: 'button',
        onclick: async () => {
          if (!name.value.trim()) return toast('Имя не может быть пустым.');
          const patch = { name: name.value.trim(), department: department.value.trim(), position: position.value.trim() };
          const { error } = await sb.from('profiles').update(patch).eq('id', me.id);
          if (error) return toast('Не получилось сохранить.');
          Object.assign(state.me, patch);
          state.profiles.set(me.id, { ...profile(me.id), ...patch });
          renderMe();
          toast('Сохранено');
        },
      }, 'Сохранить'));

    // Уведомления
    const status = pushStatus();
    const pushTexts = {
      on: 'Включены на этом устройстве.',
      off: 'Выключены. Включи, чтобы узнавать о новых сообщениях, когда мессенджер закрыт.',
      denied: 'Запрещены в настройках браузера. Разреши уведомления для этого сайта и вернись сюда.',
      unsupported: 'Этот браузер не умеет показывать уведомления.',
      'ios-install': 'На iPhone уведомления работают только из приложения на экране «Домой». Как добавить, написано ниже.',
    };
    body.append(h('h4', null, 'Уведомления'), h('p', { class: 'muted' }, pushTexts[status]));
    if (status === 'off') {
      body.append(h('button', {
        class: 'btn wide', type: 'button',
        onclick: async (event) => {
          event.target.disabled = true;
          const ok = await enablePush(true);
          toast(ok ? 'Уведомления включены' : 'Уведомления включить не получилось');
          settingsModal();
        },
      }, 'Включить уведомления'));
    }

    // Установка на телефон
    if (!isStandalone()) {
      body.append(
        h('h4', null, 'Приложение на телефоне'),
        h('p', { class: 'muted' }, isIOS
          ? 'Открой этот сайт в Safari, нажми «Поделиться» и выбери «На экран „Домой“». Мессенджер появится среди приложений.'
          : 'В меню браузера (три точки) выбери «Установить приложение» или «Добавить на главный экран».'));
    }

    // Администратор
    if (me.is_admin) {
      const { data: info } = await sb.rpc('admin_info');
      const code = info ? info.invite_code : '';
      const link = `${location.origin}${location.pathname}?invite=${encodeURIComponent(code)}`;
      body.append(
        h('h4', null, 'Приглашение коллег'),
        h('p', { class: 'muted' }, 'Отправь коллеге ссылку: код подставится сам. Или продиктуй код.'),
        h('div', { class: 'inline' },
          h('input', { type: 'text', readonly: true, value: code, 'aria-label': 'Код приглашения' }),
          h('button', {
            class: 'btn', type: 'button',
            onclick: async () => {
              try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } catch (error) { prompt('Скопируй ссылку:', link); }
            },
          }, 'Скопировать ссылку')),
        h('button', {
          class: 'btn wide', type: 'button',
          onclick: async () => {
            if (!confirm('Сменить код? Старый код и старые ссылки перестанут работать.')) return;
            const fresh = [...crypto.getRandomValues(new Uint8Array(5))].map((v) => v.toString(16).padStart(2, '0')).join('');
            const { error } = await sb.rpc('admin_set_invite', { p_code: fresh });
            if (error) return toast('Не получилось сменить код.');
            settingsModal();
          },
        }, 'Сменить код'),
        h('h4', null, 'Сотрудники'),
        h('div', { class: 'people' }, [...state.profiles.values()]
          .filter((p) => p.id !== me.id)
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
          .map((person) => {
            const change = async (blocked, admin) => {
              const { error } = await sb.rpc('admin_update_user', { p_user: person.id, p_blocked: blocked, p_admin: admin });
              if (error) return toast('Не получилось изменить.');
              state.profiles.set(person.id, { ...person, blocked, is_admin: admin });
              settingsModal();
            };
            return h('div', { class: 'row static' },
              avatar(person.id, person.name),
              h('span', { class: 'row-main' },
                h('strong', null, person.name),
                h('span', { class: 'preview' }, person.blocked ? 'доступ закрыт' : (person.is_admin ? 'администратор' : (person.department || 'сотрудник')))),
              h('span', { class: 'row-actions' },
                !person.blocked && h('button', { class: 'btn small', type: 'button', onclick: () => change(false, !person.is_admin) }, person.is_admin ? 'Снять админа' : 'Сделать админом'),
                h('button', { class: 'btn small', type: 'button', onclick: () => change(!person.blocked, false) }, person.blocked ? 'Вернуть доступ' : 'Закрыть доступ')));
          })));
    }

    body.append(h('button', {
      class: 'btn wide danger', type: 'button',
      onclick: () => { closeModal(); logout(); },
    }, 'Выйти из аккаунта'));

    openModal('Настройки', body);
  }

  // ───────────────────────── Уведомления ─────────────────────────

  function keyBytes(text) {
    const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  }

  // interactive=true: можно спросить разрешение (только по нажатию кнопки). Иначе тихо обновляем подписку.
  async function enablePush(interactive) {
    try {
      if (!swReady || !('PushManager' in window) || !('Notification' in window)) return false;
      if (Notification.permission === 'default') {
        if (!interactive) return false;
        await Notification.requestPermission();
      }
      if (Notification.permission !== 'granted') return false;

      let { data: key } = await sb.rpc('vapid_key');
      if (!key) {
        const { data, error } = await sb.functions.invoke('push', { body: { action: 'init' } });
        if (error || !data || !data.public_key) throw error || new Error('no key');
        key = data.public_key;
      }
      const reg = await swReady;
      let sub = await reg.pushManager.getSubscription();
      if (sub && sub.options && sub.options.applicationServerKey) {
        const current = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (current !== key) {
          await sub.unsubscribe();
          sub = null;
        }
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      const json = sub.toJSON();
      const { error } = await sb.rpc('save_push', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth });
      if (error) throw error;
      state.pushOn = true;
      return true;
    } catch (error) {
      console.warn('push', error);
      state.pushOn = false;
      return false;
    }
  }

  // Просим сервер разослать уведомление получателям. Если функция не развёрнута, после трёх неудач перестаём пытаться.
  function notifyPush(messageId) {
    if (state.pushFailures >= 3) return;
    sb.functions.invoke('push', { body: { message_id: messageId } }).then(({ error }) => {
      state.pushFailures = error ? state.pushFailures + 1 : 0;
    }).catch(() => { state.pushFailures++; });
  }

  let audio = null;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audio.currentTime);
      osc.frequency.exponentialRampToValueAtTime(660, audio.currentTime + 0.15);
      gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.25);
    } catch (error) { /* звук не обязателен */ }
  }

  async function alertUser(chat, message) {
    if (document.visibilityState === 'visible') return beep();
    // Запасной путь, если пуши не настроены: показать уведомление из открытой, но свёрнутой вкладки.
    if (state.pushOn || !swReady || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = await swReady;
      const text = previewText(message);
      await reg.showNotification(chatTitle(chat), {
        body: chat.is_group ? `${nameOf(message.sender_id)}: ${text}` : text,
        tag: chat.id,
        renotify: true,
        icon: 'icons/icon-192.png',
        badge: 'icons/badge.png',
        data: { chat_id: chat.id },
      });
    } catch (error) { /* не страшно */ }
  }

  // ───────────────────────── Живые обновления ─────────────────────────

  function onMessageChange(payload) {
    if (payload.eventType === 'DELETE') {
      removeMessage(payload.old.id);
      return;
    }
    if (payload.eventType !== 'INSERT') return;
    const message = payload.new;
    const chat = findChat(message.chat_id);
    if (!chat) return scheduleReload();

    const known = chat.last_message && chat.last_message.id === message.id;
    const mine = message.sender_id === state.me.id;
    chat.last_message = message;
    chat.last_message_at = message.created_at;

    if (message.chat_id === state.chatId) upsertMessage(message);
    if (!mine) {
      if (message.chat_id === state.chatId && isLooking()) markRead();
      else {
        if (!known) chat.unread = (Number(chat.unread) || 0) + 1;
        alertUser(chat, message);
      }
    }
    renderChatList();
  }

  function onMemberChange(payload) {
    if (payload.eventType !== 'UPDATE') return scheduleReload();
    const row = payload.new;
    const chat = findChat(row.chat_id);
    if (!chat) return scheduleReload();
    const member = (chat.members || []).find((m) => m.user_id === row.user_id);
    if (!member) return scheduleReload();
    member.last_read_at = row.last_read_at;
    member.is_owner = row.is_owner;
    if (row.user_id === state.me.id && new Date(row.last_read_at) >= new Date(chat.last_message_at) && chat.unread > 0) {
      chat.unread = 0; // прочитано на другом устройстве
      renderChatList();
    }
    if (row.chat_id === state.chatId) updateTicks();
  }

  function onChatChange(payload) {
    const chat = findChat(payload.new.id);
    if (!chat || chat.title === payload.new.title) return;
    chat.title = payload.new.title;
    renderChatList();
    renderChatHeader();
  }

  function onProfileChange(payload) {
    if (payload.eventType === 'DELETE') return;
    const row = payload.new;
    const old = profile(row.id);
    state.profiles.set(row.id, row);
    if (row.id === state.me.id) {
      state.me = row;
      if (row.blocked) return show('blocked');
    }
    if (!old || old.name !== row.name || old.blocked !== row.blocked) {
      renderChatList();
      renderMe();
    }
    renderChatHeader();
  }

  // После обрыва связи или возвращения в приложение подтягиваем всё, что могли пропустить.
  async function resync() {
    if (!state.me) return;
    try {
      await Promise.all([loadChats(), loadProfiles()]);
    } catch (error) { return; }
    renderChatList();
    renderChatHeader();
    const id = state.chatId;
    if (!id) return;
    if (!findChat(id)) return closeChat();
    const confirmed = state.messages.filter((m) => !m.pending && !m.failed);
    const last = confirmed[confirmed.length - 1];
    let query = sb.from('messages').select('*').eq('chat_id', id).order('created_at', { ascending: true }).limit(200);
    if (last) query = query.gt('created_at', last.created_at);
    const { data } = await query;
    if (state.chatId !== id || !data || !data.length) { updateTicks(); markRead(); return; }
    const have = new Set(state.messages.map((m) => m.id));
    const keepDown = stickToBottom;
    for (const message of data) {
      if (have.has(message.id)) state.messages[state.messages.findIndex((m) => m.id === message.id)] = message;
      else state.messages.push(message);
    }
    renderMessages();
    if (keepDown) scrollToBottom();
    markRead();
  }

  function subscribe() {
    dbChannel = sb.channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, onMessageChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members' }, onMemberChange)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chats' }, onChatChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, onProfileChange)
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        if (wasSubscribed) resync();
        wasSubscribed = true;
      });

    presenceChannel = sb.channel('online', { config: { presence: { key: state.me.id } } });
    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        state.online = new Set(Object.keys(presenceChannel.presenceState()));
        renderChatList();
        renderChatHeader();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') presenceChannel.track({ at: Date.now() });
      });
  }

  function heartbeat() {
    if (!state.me || document.visibilityState !== 'visible') return;
    sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', state.me.id).then(() => {});
  }

  // ───────────────────────── Запуск и остановка ─────────────────────────

  async function start(user) {
    try {
      const { data: me, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (error) throw error;
      if (!me) throw new Error('Профиль не найден. Похоже, в базе не выполнен schema.sql.');
      state.me = me;
      if (me.blocked) return show('blocked');

      await Promise.all([loadProfiles(), loadChats()]);
      show('main');
      renderMe();
      renderChatList();
      subscribe();
      heartbeat();
      heartbeatTimer = setInterval(heartbeat, 120000);
      if ('Notification' in window && Notification.permission === 'granted') enablePush(false);

      const wanted = new URLSearchParams(location.search).get('chat');
      if (wanted) {
        history.replaceState(null, '', location.pathname);
        if (findChat(wanted)) openChat(wanted);
      }
    } catch (error) {
      startedFor = null;
      show('auth');
      authError(error);
    }
  }

  function stop() {
    clearInterval(heartbeatTimer);
    if (dbChannel) sb.removeChannel(dbChannel);
    if (presenceChannel) sb.removeChannel(presenceChannel);
    dbChannel = presenceChannel = null;
    wasSubscribed = false;
    Object.assign(state, {
      me: null, profiles: new Map(), chats: [], chatId: null, messages: [],
      online: new Set(), search: '', drafts: new Map(), pushOn: false, pushFailures: 0,
    });
    $('main').classList.remove('open');
    $('chat-body').hidden = true;
    $('chat-empty').hidden = false;
    $('chat-list').replaceChildren();
    $('messages').replaceChildren();
    closeModal();
    document.title = APP_NAME;
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  }

  function autosize() {
    const input = $('message-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  function bindUI() {
    $('auth-form').addEventListener('submit', submitAuth);
    $('auth-switch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
    $('blocked-logout').addEventListener('click', logout);

    $('me-btn').addEventListener('click', settingsModal);
    $('new-chat-btn').addEventListener('click', newChatModal);
    $('chat-search').addEventListener('input', (event) => { state.search = event.target.value; renderChatList(); });
    $('chat-head').addEventListener('click', chatInfoModal);
    $('back-btn').addEventListener('click', () => {
      if (history.state && history.state.chat) history.back();
      else closeChat();
    });
    window.addEventListener('popstate', () => { if (state.chatId) closeChat(); });

    $('composer').addEventListener('submit', (event) => { event.preventDefault(); sendText(); });
    const input = $('message-input');
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isTouch()) {
        event.preventDefault();
        sendText();
      }
    });
    input.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData ? event.clipboardData.files : [])];
      if (files.length) {
        event.preventDefault();
        sendFiles(files);
      }
    });
    $('attach-btn').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (event) => {
      sendFiles(event.target.files);
      event.target.value = '';
    });

    const box = $('messages');
    box.addEventListener('scroll', () => {
      stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      if (box.scrollTop < 120) loadOlder();
    });

    // Меню сообщения: правая кнопка мыши или долгое нажатие пальцем.
    const menuFor = (target) => {
      const el = target.closest && target.closest('.msg');
      const message = el && state.messages.find((m) => m.id === el.dataset.id);
      if (message) messageMenu(message);
      return !!message;
    };
    box.addEventListener('contextmenu', (event) => {
      if (event.target.closest('a')) return;
      if (menuFor(event.target)) event.preventDefault();
    });
    let pressTimer = null;
    box.addEventListener('touchstart', (event) => {
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => menuFor(event.target), 550);
    }, { passive: true });
    for (const type of ['touchend', 'touchmove', 'touchcancel']) {
      box.addEventListener(type, () => clearTimeout(pressTimer), { passive: true });
    }

    $('viewer').addEventListener('click', (event) => { if (event.target === $('viewer')) $('viewer').close(); });
    $('modal').addEventListener('click', (event) => { if (event.target === $('modal')) closeModal(); });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { heartbeat(); resync(); }
    });
    window.addEventListener('focus', markRead);
    window.addEventListener('online', resync);

    // На телефоне клавиатура перекрывает экран: подгоняем высоту под видимую область.
    if (window.visualViewport) {
      const fit = () => {
        document.documentElement.style.setProperty('--app-height', window.visualViewport.height + 'px');
        if (stickToBottom && state.chatId) scrollToBottom();
      };
      window.visualViewport.addEventListener('resize', fit);
      fit();
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'open-chat' && data.chat_id && state.me) {
          if (findChat(data.chat_id)) openChat(data.chat_id);
          else loadChats().then(() => openChat(data.chat_id)).catch(() => {});
        }
      });
    }
  }

  function boot() {
    if (!cfg.supabaseUrl || !cfg.supabaseKey) return show('setup');
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      swReady = navigator.serviceWorker.ready;
    }
    bindUI();

    const invite = new URLSearchParams(location.search).get('invite');
    if (invite) $('auth-invite').value = invite;

    sb.auth.onAuthStateChange((event, session) => {
      // Обращаться к базе прямо внутри этого обработчика нельзя, поэтому откладываем на следующий тик.
      setTimeout(() => {
        const user = session && session.user;
        if (user) {
          if (startedFor === user.id) return;
          startedFor = user.id;
          start(user);
        } else {
          if (startedFor) stop();
          startedFor = null;
          show('auth');
          setAuthMode(invite ? 'register' : 'login');
        }
      }, 0);
    });
  }

  boot();
})();
