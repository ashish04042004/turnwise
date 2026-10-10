import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { LiveProvider } from './live.jsx';
import { ToastProvider } from './toast.jsx';
import ActivityPage from './pages/ActivityPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import BookPage from './pages/BookPage.jsx';
import FloorPage from './pages/FloorPage.jsx';
import PatientPage from './pages/PatientPage.jsx';

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/p/:token" element={<PatientPage />} />
        <Route
          element={
            <LiveProvider>
              <Layout />
            </LiveProvider>
          }
        >
          <Route index element={<FloorPage />} />
          <Route path="book" element={<BookPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="activity" element={<ActivityPage />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
