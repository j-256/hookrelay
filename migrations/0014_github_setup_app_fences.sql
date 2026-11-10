ALTER TABLE github_setup_reviews ADD COLUMN auth_fence_json TEXT CHECK(auth_fence_json IS NULL OR json_valid(auth_fence_json));
