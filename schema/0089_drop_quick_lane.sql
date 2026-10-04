-- #805 (805c). Nothing writes `quick_lane = 1` since `sequencer/quick.ts` went, so the column goes.
ALTER TABLE verdicts DROP COLUMN quick_lane;
