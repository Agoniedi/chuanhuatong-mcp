UPDATE messages
SET mentions = '[]'::jsonb
WHERE mentions = '{}'::jsonb;

ALTER TABLE messages
ADD CONSTRAINT messages_mentions_array
CHECK (jsonb_typeof(mentions) = 'array');
