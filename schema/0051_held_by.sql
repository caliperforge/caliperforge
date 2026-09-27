ALTER TABLE plans ADD COLUMN held_by TEXT CHECK (held_by IN ('ceo', 'coo'));
ALTER TABLE plans ADD COLUMN held_why TEXT CHECK (instr(held_why, char(10)) = 0);

UPDATE plans SET held_by = 'coo' WHERE state = 'blocked_on_ceo';
UPDATE plans SET held_by = 'ceo', held_why = wait_reason
  WHERE state IN ('queued', 'running') AND wait_reason IN ('target_approval', 'ceo_batch');

CREATE TRIGGER plans_held_on_entry AFTER UPDATE OF state ON plans
WHEN OLD.state <> 'blocked_on_ceo' AND NEW.state = 'blocked_on_ceo'
BEGIN UPDATE plans SET held_by = 'coo' WHERE id = NEW.id; END;

CREATE TRIGGER plans_held_on_exit AFTER UPDATE OF state ON plans
WHEN OLD.state = 'blocked_on_ceo' AND NEW.state <> 'blocked_on_ceo'
BEGIN UPDATE plans SET held_by = NULL, held_why = NULL WHERE id = NEW.id; END;
