-- Per-(slot, day) deterministic deck rotation for ad serving.
--
-- `bag` is a JSON array of ad_ids where each ad appears weight_snapshot times,
-- shuffled with a seed of `${slot}-${day}` so repeated /serve calls within a
-- day walk the same deterministic permutation. `cursor` advances atomically
-- with each call. `signature` is a stable hash of the (id, weight) set used
-- to detect mid-day ad changes — when the live ad set diverges, the bag is
-- rebuilt and the cursor resets.
--
-- Composite PK on (slot, day) so each slot keeps its own rotation per day.
CREATE TABLE IF NOT EXISTS `serve_rotation` (
    `slot` text NOT NULL,
    `day` text NOT NULL,
    `bag` text NOT NULL,
    `cursor` integer DEFAULT 0 NOT NULL,
    `signature` text NOT NULL,
    `updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
    PRIMARY KEY (`slot`, `day`)
);
