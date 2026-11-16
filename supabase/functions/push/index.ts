// Апельсин: отправка пуш-уведомлений о новых сообщениях.
// Разворачивается в Supabase → Edge Functions под именем "push".
// Никаких секретов настраивать не нужно: ключи уведомлений функция создаёт сама
// при первом вызове и хранит в таблице app_settings, закрытой от клиентов.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Шифрование содержимого по RFC 8291 (aes128gcm).
async function encrypt(payload: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const clientPublic = unb64url(p256dh);
  const clientKey = await crypto.subtle.importKey(
    "raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, local.privateKey, 256),
  );

  const ikm = await hkdf(
    unb64url(auth), shared, concat(enc.encode("WebPush: info\0"), clientPublic, localPublic), 32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = localPublic.length;
  return concat(header, localPublic, cipher);
}

type Vapid = { publicKey: string; privateKey: CryptoKey };

async function vapidHeader(endpoint: string, vapid: Vapid): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SUPABASE_URL.startsWith("https://") ? SUPABASE_URL : "mailto:push@example.com",
  })));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, vapid.privateKey, enc.encode(`${head}.${body}`),
  ));
  return `vapid t=${head}.${body}.${b64url(signature)}, k=${vapid.publicKey}`;
}

// Ключи создаются один раз. Условие "vapid_public is null" защищает от гонки двух вызовов.
async function loadVapid(): Promise<Vapid> {
  let { data } = await admin.from("app_settings").select("vapid_public, vapid_private").eq("id", 1).single();
  if (!data?.vapid_public) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await admin.from("app_settings")
      .update({ vapid_public: publicKey, vapid_private: privateJwk })
      .eq("id", 1).is("vapid_public", null);
    ({ data } = await admin.from("app_settings").select("vapid_public, vapid_private").eq("id", 1).single());
  }
  if (!data?.vapid_public) throw new Error("app_settings row is missing: run schema.sql first");
  const privateKey = await crypto.subtle.importKey(
    "jwk", data.vapid_private, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  return { publicKey: data.vapid_public, privateKey };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function preview(message: { body: string; file_name: string | null; file_type: string | null }) {
  if (message.body) return message.body.length > 140 ? message.body.slice(0, 140) + "…" : message.body;
  if (message.file_type?.startsWith("image/")) return "📷 Фото";
  return "📎 " + (message.file_name ?? "Файл");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth } = await admin.auth.getUser(token);
    const user = auth?.user;
    if (!user) return json({ error: "unauthorized" }, 401);

    const { data: me } = await admin.from("profiles").select("id, name, blocked").eq("id", user.id).single();
    if (!me || me.blocked) return json({ error: "forbidden" }, 403);

    const input = await req.json().catch(() => ({}));
    const vapid = await loadVapid();

    if (input.action === "init") return json({ public_key: vapid.publicKey });

    if (typeof input.message_id !== "string") return json({ error: "message_id required" }, 400);

    const { data: message } = await admin.from("messages")
      .select("id, chat_id, sender_id, body, file_name, file_type")
      .eq("id", input.message_id).single();
    if (!message || message.sender_id !== user.id) return json({ error: "not found" }, 404);

    const { data: chat } = await admin.from("chats").select("id, is_group, title").eq("id", message.chat_id).single();
    const { data: members } = await admin.from("chat_members")
      .select("user_id, profiles!inner(blocked)")
      .eq("chat_id", message.chat_id).neq("user_id", user.id).eq("profiles.blocked", false);
    const ids = (members ?? []).map((m) => m.user_id);
    if (!chat || ids.length === 0) return json({ sent: 0 });

    const { data: subs } = await admin.from("push_subscriptions").select("endpoint, p256dh, auth").in("user_id", ids);

    const text = preview(message);
    const payload = enc.encode(JSON.stringify({
      title: chat.is_group ? (chat.title ?? "Группа") : me.name,
      body: chat.is_group ? `${me.name}: ${text}` : text,
      chat_id: chat.id,
    }));

    let sent = 0;
    const dead: string[] = [];
    await Promise.allSettled((subs ?? []).map(async (sub) => {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Authorization": await vapidHeader(sub.endpoint, vapid),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          "TTL": "86400",
          "Urgency": "high",
        },
        body: await encrypt(payload, sub.p256dh, sub.auth),
      });
      if (res.status === 404 || res.status === 410) dead.push(sub.endpoint);
      else if (res.ok) sent++;
      else console.error("push failed", res.status, await res.text());
    }));

    if (dead.length) await admin.from("push_subscriptions").delete().in("endpoint", dead);
    return json({ sent });
  } catch (error) {
    console.error(error);
    return json({ error: String(error) }, 500);
  }
});
