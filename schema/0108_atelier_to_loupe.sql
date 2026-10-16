UPDATE pipes SET name = 'loupe' WHERE name = 'atelier' AND NOT EXISTS (SELECT 1 FROM pipes WHERE name = 'loupe');
UPDATE plans SET pipe_id = (SELECT id FROM pipes WHERE name = 'loupe') WHERE pipe_id = (SELECT id FROM pipes WHERE name = 'atelier');
UPDATE plans SET lane = 'loupe' WHERE lane = 'atelier';
