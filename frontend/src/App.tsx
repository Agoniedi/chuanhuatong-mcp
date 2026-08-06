import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useApp } from './store/AppContext';
import AuthPage from './pages/AuthPage';
import RoomListPage from './pages/RoomListPage';
import RoomPage from './pages/RoomPage';
import JoinPage from './pages/JoinPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { state } = useApp();
  if (!state.token) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

export default function App() {
  const { state } = useApp();
  const location = useLocation();
  const authRedirect = new URLSearchParams(location.search).get('redirect') ?? '/';
  return (
    <Routes>
      <Route path="/auth" element={state.token ? <Navigate to={authRedirect} replace /> : <AuthPage />} />
      <Route path="/join/:inviteCode" element={<JoinPage />} />
      <Route path="/rooms/:roomId" element={<ProtectedRoute><RoomPage /></ProtectedRoute>} />
      <Route path="/" element={<ProtectedRoute><RoomListPage /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
