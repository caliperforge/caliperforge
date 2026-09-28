UPDATE plans SET held_why = NULL WHERE state = 'blocked_on_ceo' AND waits_on IS NOT NULL;
