import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useConfig } from '../config.jsx';
import { clock } from '../format.js';
import { useLive } from '../live.jsx';

const NAV = [
  ['/', 'Floor'],
  ['/book', 'Book & walk-in', 'frontDesk'],
  ['/analytics', 'Analytics'],
  ['/activity', 'Activity'],
  ['/staff', 'Staff', 'staff'],
  ['/settings', 'Settings', 'settings'],
];

export default function Layout() {
  const { board, connected, error } = useLive();
  const { staff, signOut, can } = useAuth();
  const { roleLabel } = useConfig();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width="30" height="30" />
          <div>
            <div className="brand-name">Turnwise</div>
            <div className="brand-tag">Smarter turns. Smoother operations.</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.filter(([, , permission]) => !permission || can(permission)).map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          {board && (
            <div className="centre">
              <strong>{board.centre.name}</strong>
              <span>{board.centre.city}</span>
            </div>
          )}
          {board && <div className="clock">{clock(board.now)}</div>}
          <div className={`live ${connected ? 'on' : 'off'}`} title={connected ? 'Receiving live updates' : 'Reconnecting…'}>
            <span className="dot" /> {connected ? 'Live' : 'Offline'}
          </div>
          {staff && (
            <div className="whoami">
              <span>
                <strong>{staff.name}</strong>
                <span>{roleLabel(staff.role)}</span>
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={signOut}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="main">
        {error && !board ? (
          <div className="empty">
            <h2>Can’t reach the Turnwise API</h2>
            <p>{error}</p>
            <p className="muted">Start it with <code>npm run dev</code> after <code>npm run infra:up</code> and <code>npm run setup</code>.</p>
          </div>
        ) : !board ? (
          <div className="empty">Loading the floor…</div>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
