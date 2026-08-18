ALTER TABLE rooms
  ADD CONSTRAINT rooms_world_invite_fk
  FOREIGN KEY (world_invite_id)
  REFERENCES room_invites(id)
  ON DELETE SET NULL;
