import { describe, expect, it } from 'vitest';

import { isCurrentUserMessage } from './messageIdentity';

describe('isCurrentUserMessage', () => {
  it('does not treat an owned agent as the current user', () => {
    expect(isCurrentUserMessage({
      kind: 'agent',
      userId: 'owner-1',
      agentProfileId: 'agent-1',
      displayNameSnapshot: '夏小棠',
      avatarResourceIdSnapshot: null,
    }, 'owner-1')).toBe(false);
  });
});
