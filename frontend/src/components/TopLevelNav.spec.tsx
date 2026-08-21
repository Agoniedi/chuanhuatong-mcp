import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import TopLevelNav from './TopLevelNav';

afterEach(cleanup);

describe('TopLevelNav', () => {
  it('renders every top-level destination and only marks the current route active', () => {
    render(
      <MemoryRouter initialEntries={['/world']}>
        <TopLevelNav />
      </MemoryRouter>,
    );

    const rooms = screen.getByRole('link', { name: '房间' });
    const world = screen.getByRole('link', { name: '世界' });
    const settings = screen.getByRole('link', { name: '设置' });

    expect(rooms.getAttribute('href')).toBe('/');
    expect(world.getAttribute('href')).toBe('/world');
    expect(settings.getAttribute('href')).toBe('/settings');
    expect(rooms.classList.contains('active')).toBe(false);
    expect(world.classList.contains('active')).toBe(true);
    expect(settings.classList.contains('active')).toBe(false);
  });

  it('does not keep the root destination active on another top-level route', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <TopLevelNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '房间' }).classList.contains('active')).toBe(false);
    expect(screen.getByRole('link', { name: '设置' }).classList.contains('active')).toBe(true);
  });
});
