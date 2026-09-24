INSERT INTO pipes (id, name, enabled, window_start, window_end, max_concurrent) VALUES (9, 'wake', 1, '00:00', '23:59', 1);

INSERT INTO rules (id, kind, path, content_hash, loaded_at)
  VALUES ('typescript_specialist', 'roster', 'seats/typescript_specialist', printf('%064d', 0), '2026-09-24');

INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin, wait_reason)
  VALUES (7, 9, 'pr_path', 'running', '2026-09-24', 4, 0, 1, 'machine', 'typescript_specialist',
    'https://github.com/caliperforge/caliperforge/issues/139', 'token_ceiling');

INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path) VALUES
  (7, 2, 'typescript_specialist', printf('%064d', 0), 'claude-agent-sdk', 'claude-opus-5-5', 'high', 1000, 900000, 200, 60, 0, '.cf/work/7/step-2.transcript.jsonl'),
  (7, 3, 'typescript_specialist', printf('%064d', 0), 'claude-agent-sdk', 'claude-opus-5-5', 'high', 3000, 900000, 400, 90, 0, '.cf/work/7/step-3.transcript.jsonl');

INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds)
  VALUES ('review', 'review', printf('%064d', 1), 7, 4, 'refuse', 'ruling', 'reviewers.verdict', 0, 0);

INSERT INTO refusals (plan, step, fingerprint, blip) VALUES (7, 4, printf('%064d', 2), 0);

INSERT INTO merges (plan, step, at, main, incoming, mine, overlap, clean)
  VALUES (7, 4, '2026-09-24', printf('%040d', 3), '[]', '[]', 0, 1);
