ALTER TABLE plans ADD COLUMN held_until TEXT;

DROP TRIGGER plans_held_on_exit;

CREATE TRIGGER plans_held_on_exit AFTER UPDATE OF state ON plans
WHEN OLD.state = 'blocked_on_ceo' AND NEW.state <> 'blocked_on_ceo'
BEGIN UPDATE plans SET held_by = NULL, held_why = NULL, held_until = NULL WHERE id = NEW.id; END;
