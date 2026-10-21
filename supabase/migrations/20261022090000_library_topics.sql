-- Content library: topics, and links shown inside the portal.
--
-- 1. Each item can carry a topic and a sub-topic (e.g. Numbers › Fractions).
--    Each visit keeps the item's topic and sub-topic as they were when it
--    was opened, so the usage report by topic stays true if an item is
--    re-tagged later.
-- 2. A link's site decides whether other sites may show its pages in a
--    frame (X-Frame-Options / frame-ancestors). The API asks it when the
--    link is added or changed, and about weekly after (embed.ts), and keeps
--    the answer here: true — the portal opens it in its own viewer; false
--    or null — it opens in a new tab.
--
-- Additive only; safe to re-run.

alter table public.library_items add column if not exists topic text
  check (topic is null or length(topic) <= 120);
alter table public.library_items add column if not exists subtopic text
  check (subtopic is null or length(subtopic) <= 120);
alter table public.library_items add column if not exists embeddable boolean;
alter table public.library_items add column if not exists embed_checked_at timestamptz;

alter table public.library_interactions add column if not exists topic text;
alter table public.library_interactions add column if not exists subtopic text;

comment on column public.library_items.topic is 'The topic this item covers (e.g. Numbers); usage is reported by it.';
comment on column public.library_items.subtopic is 'The sub-topic within the topic (e.g. Fractions).';
comment on column public.library_items.embeddable is 'A link''s site allows being shown inside the portal (asked by the API); null = not known yet / not a link.';
comment on column public.library_interactions.topic is 'The item''s topic when it was opened.';
comment on column public.library_interactions.subtopic is 'The item''s sub-topic when it was opened.';
