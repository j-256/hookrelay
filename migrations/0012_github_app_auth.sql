CREATE TABLE github_auth_descriptors (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  key_revision INTEGER NOT NULL CHECK (key_revision > 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  write_id TEXT NOT NULL
);
CREATE TABLE github_auth_candidates (
  id TEXT PRIMARY KEY,
  descriptor_id TEXT NOT NULL,
  prior_revision INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','staged','deployment_indeterminate','deployed','verified','active','conflict')),
  version_id TEXT,
  attestation_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  activated_at INTEGER
);
CREATE INDEX github_auth_candidates_expiry ON github_auth_candidates(state,expires_at);
CREATE TABLE github_auth_attestations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES github_auth_candidates(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  version_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE github_auth_challenges (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES github_auth_candidates(id) ON DELETE CASCADE,
  nonce_hash TEXT NOT NULL UNIQUE,
  version_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);
CREATE TABLE github_auth_authority (
  descriptor_id TEXT NOT NULL REFERENCES github_auth_descriptors(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL,
  capability TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  revision INTEGER,
  key_revision INTEGER,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown','allowed','denied')),
  digest TEXT,
  observed_at INTEGER,
  valid_until INTEGER,
  write_id TEXT NOT NULL,
  PRIMARY KEY(descriptor_id,repository_id,capability)
);
CREATE TABLE github_auth_cooldowns (quota_key TEXT PRIMARY KEY,retry_at INTEGER NOT NULL);
CREATE TRIGGER github_auth_descriptor_invalidation AFTER UPDATE ON github_auth_descriptors
BEGIN
  UPDATE github_auth_authority SET generation=generation+1,state='unknown',digest=NULL,observed_at=NULL,valid_until=NULL,write_id=NEW.write_id WHERE descriptor_id=NEW.id;
END;
CREATE TRIGGER github_auth_candidate_activation AFTER UPDATE OF state ON github_auth_candidates
WHEN NEW.state='active' AND OLD.state<>'active'
BEGIN
  INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id)
  VALUES(NEW.descriptor_id,json_extract(NEW.metadata_json,'$.revision'),json_extract(NEW.metadata_json,'$.keyRevision'),NEW.metadata_json,NEW.id)
  ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,key_revision=excluded.key_revision,metadata_json=excluded.metadata_json,write_id=excluded.write_id;
  UPDATE github_auth_attestations SET consumed_at=NEW.activated_at WHERE id=NEW.attestation_id;
END;
