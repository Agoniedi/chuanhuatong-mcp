import type { MessageSender } from './types';

export function isCurrentUserMessage(sender: MessageSender, currentUserId: string) {
  return sender.kind === 'human' && sender.userId === currentUserId;
}
