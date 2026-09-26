ALTER TABLE targets ADD COLUMN coo_take TEXT CHECK ((coo_take GLOB 'take *' OR coo_take GLOB 'skip *')
  AND instr(coo_take, char(9)) = 0 AND instr(coo_take, char(10)) = 0);
