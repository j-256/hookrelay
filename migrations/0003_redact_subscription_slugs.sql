-- Values written before hashed subscription lookup were raw bearer credentials
-- The legacy column name remains for schema compatibility; new values are hashes
UPDATE events SET sub_slug = 'legacy-redacted';
