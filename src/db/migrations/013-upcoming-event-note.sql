-- "Anything big coming up?" gained a free-text line for "Something else",
-- so the app knows what the event actually is instead of just that one
-- exists. Null unless 'other' is among upcoming_events.
ALTER TABLE user_info ADD COLUMN IF NOT EXISTS upcoming_event_note TEXT;
