-- A note brought back from a merge remembers which note it was separated from, so a consolidation job
-- doesn't merge the two again.
ALTER TABLE notes ADD COLUMN unmerged_from bigint REFERENCES notes (id);
