ALTER TABLE timers
  ADD COLUMN IF NOT EXISTS background_animation varchar(20) NOT NULL DEFAULT 'particles';
