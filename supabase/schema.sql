-- Апельсин: схема рабочего мессенджера.
-- Выполнить один раз в Supabase → SQL Editor → New query → Run.
-- Скрипт можно запускать повторно: он ничего не удаляет и не ломает данные.

-- ───────────────────────── Таблицы ─────────────────────────

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  department text not null default '' check (char_length(department) <= 60),
  position   text not null default '' check (char_length(position) <= 60),
  is_admin   boolean not null default false,
  blocked    boolean not null default false,
  last_seen  timestamptz,
  created_at timestamptz not null default now()
);

-- Одна строка с настройками. Клиентам напрямую недоступна (только через функции ниже).
create table if not exists public.app_settings (
  id            int primary key default 1 check (id = 1),
  invite_code   text not null default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  vapid_public  text,
  vapid_private jsonb
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.chats (
  id              uuid primary key default gen_random_uuid(),
  is_group        boolean not null default false,
  title           text check (title is null or char_length(title) between 1 and 80),
  direct_key      text unique,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  chat_id      uuid not null references public.chats (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  is_owner     boolean not null default false,
  last_read_at timestamptz not null default now(),
  joined_at    timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index if not exists chat_members_user_idx on public.chat_members (user_id);

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references public.chats (id) on delete cascade,
  sender_id  uuid references public.profiles (id) on delete set null,
  body       text not null default '' check (char_length(body) <= 4000),
  file_path  text,
  file_name  text check (file_name is null or char_length(file_name) <= 200),
  file_type  text,
  file_size  bigint,
  created_at timestamptz not null default now(),
  check (body <> '' or file_path is not null)
);
create index if not exists messages_chat_idx on public.messages (chat_id, created_at desc);

create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ───────────────────────── Вспомогательные проверки ─────────────────────────

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and not blocked);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_admin and not blocked);
$$;

create or replace function public.is_member(p_chat uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from chat_members m
    join profiles p on p.id = m.user_id
    where m.chat_id = p_chat and m.user_id = auth.uid() and not p.blocked
  );
$$;

-- Для файлов: первая папка в пути — это id чата.
create or replace function public.is_member_of_path(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return public.is_member(split_part(p_name, '/', 1)::uuid);
exception when others then
  return false;
end;
$$;

-- ───────────────────────── Регистрация по приглашению ─────────────────────────

-- Самый первый пользователь регистрируется без кода и становится администратором.
create or replace function public.needs_invite() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles);
$$;

create or replace function public.check_invite(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles)
      or exists (select 1 from app_settings where id = 1 and invite_code = trim(p_code));
$$;

create or replace function public.signup_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.check_invite(coalesce(new.raw_user_meta_data ->> 'invite', '')) then
    raise exception 'INVITE_INVALID';
  end if;
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invite';
  return new;
end;
$$;

create or replace function public.signup_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name, is_admin)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)), 60),
    not exists (select 1 from profiles)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists messenger_signup_guard on auth.users;
create trigger messenger_signup_guard before insert on auth.users
for each row execute function public.signup_guard();

drop trigger if exists messenger_signup_profile on auth.users;
create trigger messenger_signup_profile after insert on auth.users
for each row execute function public.signup_profile();

-- Обычный пользователь не может сам себе выдать админа или снять блокировку:
-- эти поля меняются только через функции администратора.
create or replace function public.profile_protect() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.id := old.id;
    new.is_admin := old.is_admin;
    new.blocked := old.blocked;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists profile_protect on public.profiles;
create trigger profile_protect before update on public.profiles
for each row execute function public.profile_protect();

-- ───────────────────────── Сообщения: серверное время и счётчики ─────────────────────────

create or replace function public.message_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := clock_timestamp();
  if auth.uid() is not null then
    new.sender_id := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.message_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update chats set last_message_at = new.created_at where id = new.chat_id;
  update chat_members set last_read_at = new.created_at
  where chat_id = new.chat_id and user_id = new.sender_id;
  return new;
end;
$$;

drop trigger if exists message_before_insert on public.messages;
create trigger message_before_insert before insert on public.messages
for each row execute function public.message_before_insert();

drop trigger if exists message_after_insert on public.messages;
create trigger message_after_insert after insert on public.messages
for each row execute function public.message_after_insert();

-- ───────────────────────── Права доступа (RLS) ─────────────────────────

alter table public.profiles           enable row level security;
alter table public.app_settings       enable row level security;
alter table public.chats              enable row level security;
alter table public.chat_members       enable row level security;
alter table public.messages           enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on public.profiles, public.app_settings, public.chats, public.chat_members,
              public.messages, public.push_subscriptions from anon, authenticated;

grant select on public.profiles, public.chats, public.chat_members, public.messages to authenticated;
grant update (name, department, position, last_seen) on public.profiles to authenticated;
grant insert, delete on public.messages to authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() and not blocked) with check (id = auth.uid());

drop policy if exists chats_select on public.chats;
create policy chats_select on public.chats for select to authenticated
  using (public.is_member(id));

drop policy if exists chat_members_select on public.chat_members;
create policy chat_members_select on public.chat_members for select to authenticated
  using (public.is_member(chat_id));

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (public.is_member(chat_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (public.is_member(chat_id));

drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (sender_id = auth.uid() and public.is_member(chat_id));

-- ───────────────────────── Функции для приложения ─────────────────────────

create or replace function public.start_direct(p_other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me  uuid := auth.uid();
  v_key text;
  v_id  uuid;
begin
  if not public.is_active() then raise exception 'NOT_ALLOWED'; end if;
  if p_other = v_me or not exists (select 1 from profiles where id = p_other and not blocked) then
    raise exception 'USER_NOT_FOUND';
  end if;
  v_key := least(v_me::text, p_other::text) || ':' || greatest(v_me::text, p_other::text);
  select id into v_id from chats where direct_key = v_key;
  if v_id is null then
    insert into chats (is_group, direct_key, created_by) values (false, v_key, v_me)
    on conflict (direct_key) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from chats where direct_key = v_key;
    end if;
    insert into chat_members (chat_id, user_id) values (v_id, v_me), (v_id, p_other)
    on conflict do nothing;
  end if;
  return v_id;
end;
$$;

create or replace function public.create_group(p_title text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
begin
  if not public.is_active() then raise exception 'NOT_ALLOWED'; end if;
  if char_length(trim(coalesce(p_title, ''))) = 0 then raise exception 'TITLE_REQUIRED'; end if;
  insert into chats (is_group, title, created_by) values (true, left(trim(p_title), 80), v_me)
  returning id into v_id;
  insert into chat_members (chat_id, user_id, is_owner) values (v_id, v_me, true);
  insert into chat_members (chat_id, user_id)
  select v_id, p.id from profiles p
  where p.id = any (coalesce(p_members, '{}')) and p.id <> v_me and not p.blocked
  on conflict do nothing;
  return v_id;
end;
$$;

create or replace function public.add_members(p_chat uuid, p_members uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_chat) or not exists (select 1 from chats where id = p_chat and is_group) then
    raise exception 'NOT_ALLOWED';
  end if;
  insert into chat_members (chat_id, user_id)
  select p_chat, p.id from profiles p
  where p.id = any (coalesce(p_members, '{}')) and not p.blocked
  on conflict do nothing;
end;
$$;

-- Выйти из группы самому или (владельцу) убрать участника.
create or replace function public.remove_member(p_chat uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := auth.uid();
  v_owner boolean;
begin
  if not public.is_member(p_chat) or not exists (select 1 from chats where id = p_chat and is_group) then
    raise exception 'NOT_ALLOWED';
  end if;
  select is_owner into v_owner from chat_members where chat_id = p_chat and user_id = v_me;
  if p_user <> v_me and not v_owner then raise exception 'NOT_ALLOWED'; end if;

  delete from chat_members where chat_id = p_chat and user_id = p_user;

  if not exists (select 1 from chat_members where chat_id = p_chat) then
    delete from chats where id = p_chat;
  elsif not exists (select 1 from chat_members where chat_id = p_chat and is_owner) then
    update chat_members set is_owner = true
    where chat_id = p_chat
      and user_id = (select user_id from chat_members where chat_id = p_chat order by joined_at, user_id limit 1);
  end if;
end;
$$;

create or replace function public.rename_chat(p_chat uuid, p_title text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from chat_members where chat_id = p_chat and user_id = auth.uid() and is_owner)
     or not public.is_member(p_chat) then
    raise exception 'NOT_ALLOWED';
  end if;
  if char_length(trim(coalesce(p_title, ''))) = 0 then raise exception 'TITLE_REQUIRED'; end if;
  update chats set title = left(trim(p_title), 80) where id = p_chat and is_group;
end;
$$;

create or replace function public.mark_read(p_chat uuid) returns void
language sql security definer set search_path = public as $$
  update chat_members set last_read_at = clock_timestamp()
  where chat_id = p_chat and user_id = auth.uid();
$$;

-- Список моих чатов одним запросом: последнее сообщение, непрочитанные, участники.
create or replace function public.my_chats() returns table (
  id uuid, is_group boolean, title text, last_message_at timestamptz,
  unread bigint, last_message json, members json
)
language sql stable security definer set search_path = public as $$
  select c.id, c.is_group, c.title, c.last_message_at,
    (select count(*) from messages x
      where x.chat_id = c.id and x.created_at > me.last_read_at
        and x.sender_id is distinct from auth.uid()),
    (select row_to_json(l) from (
       select x.id, x.body, x.sender_id, x.file_name, x.file_type, x.created_at
       from messages x where x.chat_id = c.id order by x.created_at desc limit 1) l),
    (select json_agg(json_build_object(
       'user_id', m.user_id, 'is_owner', m.is_owner, 'last_read_at', m.last_read_at))
     from chat_members m where m.chat_id = c.id)
  from chats c
  join chat_members me on me.chat_id = c.id and me.user_id = auth.uid()
  where public.is_active()
  order by c.last_message_at desc;
$$;

-- ───────────────────────── Администратор ─────────────────────────

create or replace function public.admin_info() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_ALLOWED'; end if;
  return (select json_build_object('invite_code', invite_code) from app_settings where id = 1);
end;
$$;

create or replace function public.admin_set_invite(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_ALLOWED'; end if;
  if char_length(trim(coalesce(p_code, ''))) < 6 then raise exception 'CODE_TOO_SHORT'; end if;
  update app_settings set invite_code = trim(p_code) where id = 1;
end;
$$;

create or replace function public.admin_update_user(p_user uuid, p_blocked boolean, p_admin boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() or p_user = auth.uid() then raise exception 'NOT_ALLOWED'; end if;
  update profiles set blocked = p_blocked, is_admin = p_admin where id = p_user;
  if p_blocked then
    delete from push_subscriptions where user_id = p_user;
  end if;
end;
$$;

-- ───────────────────────── Уведомления ─────────────────────────

create or replace function public.vapid_key() returns text
language sql stable security definer set search_path = public as $$
  select vapid_public from app_settings where id = 1 and public.is_active();
$$;

create or replace function public.save_push(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_active() then raise exception 'NOT_ALLOWED'; end if;
  insert into push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

create or replace function public.delete_push(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

-- ───────────────────────── Кто что может вызывать ─────────────────────────

revoke execute on all functions in schema public from public, anon;
grant execute on function public.needs_invite(), public.check_invite(text) to anon, authenticated;
grant execute on function
  public.is_active(), public.is_admin(), public.is_member(uuid), public.is_member_of_path(text),
  public.start_direct(uuid), public.create_group(text, uuid[]), public.add_members(uuid, uuid[]),
  public.remove_member(uuid, uuid), public.rename_chat(uuid, text), public.mark_read(uuid),
  public.my_chats(), public.admin_info(), public.admin_set_invite(text),
  public.admin_update_user(uuid, boolean, boolean), public.vapid_key(),
  public.save_push(text, text, text), public.delete_push(text)
to authenticated;

-- ───────────────────────── Мгновенная доставка (Realtime) ─────────────────────────

do $$
declare t text;
begin
  foreach t in array array['messages', 'chat_members', 'chats', 'profiles'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ───────────────────────── Файлы и фото ─────────────────────────

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 26214400)
on conflict (id) do nothing;

drop policy if exists chat_files_select on storage.objects;
create policy chat_files_select on storage.objects for select to authenticated
  using (bucket_id = 'chat-files' and public.is_member_of_path(name));

drop policy if exists chat_files_insert on storage.objects;
create policy chat_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.is_member_of_path(name));

-- ───────────────────────── Мини-приложение «Учёт плёнок» ─────────────────────────
-- Продавец вносит по каждой плёнке базу и факт, администратор смотрит расхождения
-- и сам проставляет, сколько штук сейчас в пути.

create table if not exists public.stock_items (
  id         uuid primary key default gen_random_uuid(),
  code       text not null check (char_length(code) between 1 and 40),
  name       text not null check (char_length(name) between 1 and 120),
  sort       int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_points (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (char_length(name) between 1 and 60),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_reports (
  id         uuid primary key default gen_random_uuid(),
  point_id   uuid not null references public.stock_points (id),
  author_id  uuid references public.profiles (id) on delete set null,
  comment    text not null default '' check (char_length(comment) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists stock_reports_created_idx on public.stock_reports (created_at desc);

create table if not exists public.stock_lines (
  report_id  uuid not null references public.stock_reports (id) on delete cascade,
  item_id    uuid not null references public.stock_items (id),
  base       int not null check (base between 0 and 100000),
  fact       int not null check (fact between 0 and 100000),
  in_transit int not null default 0 check (in_transit between 0 and 100000),
  comment    text not null default '' check (char_length(comment) <= 300),
  primary key (report_id, item_id)
);

-- Сообщение-уведомление в чате ссылается на отчёт, чтобы его можно было открыть одной кнопкой.
alter table public.messages
  add column if not exists report_id uuid references public.stock_reports (id) on delete set null;

alter table public.stock_items   enable row level security;
alter table public.stock_points  enable row level security;
alter table public.stock_reports enable row level security;
alter table public.stock_lines   enable row level security;

grant select on public.stock_items, public.stock_points, public.stock_reports, public.stock_lines to authenticated;
grant insert, update on public.stock_items, public.stock_points to authenticated;
grant update (in_transit) on public.stock_lines to authenticated;

create or replace function public.can_see_report(p_report uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from stock_reports r
    where r.id = p_report and r.author_id = auth.uid() and public.is_active()
  );
$$;

drop policy if exists stock_items_select on public.stock_items;
create policy stock_items_select on public.stock_items for select to authenticated
  using (public.is_active());
drop policy if exists stock_items_insert on public.stock_items;
create policy stock_items_insert on public.stock_items for insert to authenticated
  with check (public.is_admin());
drop policy if exists stock_items_update on public.stock_items;
create policy stock_items_update on public.stock_items for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists stock_points_select on public.stock_points;
create policy stock_points_select on public.stock_points for select to authenticated
  using (public.is_active());
drop policy if exists stock_points_insert on public.stock_points;
create policy stock_points_insert on public.stock_points for insert to authenticated
  with check (public.is_admin());
drop policy if exists stock_points_update on public.stock_points;
create policy stock_points_update on public.stock_points for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists stock_reports_select on public.stock_reports;
create policy stock_reports_select on public.stock_reports for select to authenticated
  using (public.can_see_report(id));

drop policy if exists stock_lines_select on public.stock_lines;
create policy stock_lines_select on public.stock_lines for select to authenticated
  using (public.can_see_report(report_id));
drop policy if exists stock_lines_update on public.stock_lines;
create policy stock_lines_update on public.stock_lines for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Отправка отчёта: сохраняет строки и пишет каждому администратору сообщение в личный чат.
-- p_lines: [{"item_id": "...", "base": 10, "fact": 9, "comment": "..."}]
create or replace function public.submit_stock_report(p_point uuid, p_comment text, p_lines jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_me       uuid := auth.uid();
  v_point    text;
  v_report   uuid;
  v_total    int;
  v_diffs    int;
  v_admin    uuid;
  v_chat     uuid;
  v_message  uuid;
  v_messages uuid[] := '{}';
  v_text     text;
begin
  if not public.is_active() then raise exception 'NOT_ALLOWED'; end if;
  select name into v_point from stock_points where id = p_point and active;
  if v_point is null then raise exception 'POINT_NOT_FOUND'; end if;

  insert into stock_reports (point_id, author_id, comment)
  values (p_point, v_me, left(trim(coalesce(p_comment, '')), 1000))
  returning id into v_report;

  insert into stock_lines (report_id, item_id, base, fact, comment)
  select v_report, i.id, x.base, x.fact, left(trim(coalesce(x.comment, '')), 300)
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(item_id uuid, base int, fact int, comment text)
  join stock_items i on i.id = x.item_id and i.active
  where x.base is not null and x.fact is not null;

  select count(*), count(*) filter (where base <> fact) into v_total, v_diffs
  from stock_lines where report_id = v_report;
  if v_total = 0 then raise exception 'NO_LINES'; end if;

  v_text := '📋 Учёт плёнок, ' || v_point || ': '
    || case when v_diffs = 0 then 'расхождений нет' else 'расхождений: ' || v_diffs end
    || ' (позиций: ' || v_total || ')';

  for v_admin in select id from profiles where is_admin and not blocked and id <> v_me loop
    v_chat := public.start_direct(v_admin);
    insert into messages (chat_id, body, report_id) values (v_chat, v_text, v_report)
    returning id into v_message;
    v_messages := v_messages || v_message;
  end loop;

  return json_build_object('report_id', v_report, 'message_ids', v_messages);
end;
$$;

revoke execute on function public.can_see_report(uuid), public.submit_stock_report(uuid, text, jsonb) from public, anon;
grant execute on function public.can_see_report(uuid), public.submit_stock_report(uuid, text, jsonb) to authenticated;
