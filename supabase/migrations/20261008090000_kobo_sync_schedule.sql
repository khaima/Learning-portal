-- KoboToolbox syncs by itself every hour (docs/AUDIT.md, P1-4), so field
-- submissions reach the dashboards without anyone pressing Sync — and each
-- run re-checks every submission with the current rules. pg_cron calls the
-- api function's POST /kobo/sync/run with the same Vault-kept secret as the
-- hourly notifications run; the database checks it (notify_cron_secret_ok).
-- At 37 past, away from the notifications run at 7 past.
-- Safe to re-run: cron.schedule replaces a job of the same name.

select cron.schedule('hpf-kobo-sync-hourly', '37 * * * *', $job$
  select net.http_post(
    url := 'https://fwpqytrdlmxymvegvgji.supabase.co/functions/v1/api/kobo/sync/run',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);
