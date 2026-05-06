ALTER TABLE `chest_reward_items`
  ADD COLUMN `rampEveryDays` INTEGER NULL,
  ADD COLUMN `rampStep` INTEGER NULL,
  ADD COLUMN `rampMaxExtra` INTEGER NULL;

ALTER TABLE `chest_reward_items`
  DROP COLUMN `blockWhenDrawBelow`;
