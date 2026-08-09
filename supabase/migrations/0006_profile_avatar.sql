-- Tolong Alih — let a driver carry a face.
-- Run once per environment. Replace {{SCHEMA}} with app_alih_uat or app_alih_prod.
--
-- Google sign-in already hands us a photo, but an email signup has none and
-- anyone may want to override what Google gave. Stored as a small data URL
-- rather than a Storage bucket: the client downscales to 128px first, so the
-- rows stay tiny and there is no bucket, no policy set and no CDN to run.

alter table {{SCHEMA}}.profiles add column if not exists avatar_url text;
