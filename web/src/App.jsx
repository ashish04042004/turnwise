import { Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { ConfigProvider } from './config.jsx';
import { LiveProvider } from './live.jsx';
import { ToastProvider } from './toast.jsx';
import ActivityPage from './pages/ActivityPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import BookPage from './pages/BookPage.jsx';
import CataloguePage from './pages/CataloguePage.jsx';
import FloorPage from './pages/FloorPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import PatientPage from './pages/PatientPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import StaffPage from './pages/StaffPage.jsx';

function StaffArea() {
  const { session } = useAuth();
  if (session === undefined) return <div className="empty">Loading…</div>;
  if (!session) return <LoginPage />;
  return (
    <LiveProvider key={session.staff.id}>
      <ConfigProvider>
        <Layout />
      </ConfigProvider>
    </LiveProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route path="/p/:token" element={<PatientPage />} />
          <Route element={<StaffArea />}>
            <Route index element={<FloorPage />} />
            <Route path="book" element={<BookPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="staff" element={<StaffPage />} />
            <Route path="catalogue" element={<CataloguePage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
