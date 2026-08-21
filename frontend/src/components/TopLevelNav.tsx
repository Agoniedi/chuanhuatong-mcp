import { NavLink } from 'react-router-dom';

const items = [
  {
    to: '/',
    label: '房间',
    end: true,
    icon: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v9a2.5 2.5 0 0 1-2.5 2.5H11l-4 3v-3h-.5A2.5 2.5 0 0 1 4 14.5v-9Z" />,
  },
  {
    to: '/world',
    label: '世界',
    icon: <><circle cx="12" cy="12" r="8.5" /><path d="M3.8 9h16.4M3.8 15h16.4M12 3.5c2 2.3 3.1 5.1 3.1 8.5S14 18.2 12 20.5c-2-2.3-3.1-5.1-3.1-8.5S10 5.8 12 3.5Z" /></>,
  },
  {
    to: '/settings',
    label: '设置',
    icon: <><circle cx="12" cy="8" r="3.2" /><path d="M5 20c.4-3.4 3.2-5.7 7-5.7s6.6 2.3 7 5.7" /></>,
  },
];

export default function TopLevelNav() {
  return (
    <nav className="top-level-nav" aria-label="主导航">
      {items.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => isActive ? 'active' : undefined}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              {item.icon}
            </g>
          </svg>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
