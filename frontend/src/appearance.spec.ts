import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyBubbleColor,
  applyBubbleOpacity,
  readBubbleColor,
  readBubbleOpacity,
} from './appearance';

describe('chat appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--bubble-opacity');
  });

  it('persists and applies the selected bubble opacity', () => {
    applyBubbleOpacity(86);

    expect(readBubbleOpacity()).toBe(86);
    expect(document.documentElement.style.getPropertyValue('--bubble-opacity')).toBe('86%');
  });

  it('clamps bubble opacity to the supported range', () => {
    applyBubbleOpacity(20);
    expect(readBubbleOpacity()).toBe(20);

    applyBubbleOpacity(5);
    expect(readBubbleOpacity()).toBe(10);

    applyBubbleOpacity(120);
    expect(readBubbleOpacity()).toBe(100);
  });

  it('persists and applies the selected bubble color', () => {
    applyBubbleColor('#12abef');

    expect(readBubbleColor()).toBe('#12abef');
    expect(document.documentElement.style.getPropertyValue('--bubble-self-top')).toBe('#12abef');
    expect(document.documentElement.style.getPropertyValue('--bubble-self-bottom')).toBe('#12abef');
    expect(document.documentElement.style.getPropertyValue('--bubble-self-text')).toBe('#101114');

    applyBubbleColor('#234567');
    expect(document.documentElement.style.getPropertyValue('--bubble-self-text')).toBe('#ffffff');
  });
});
