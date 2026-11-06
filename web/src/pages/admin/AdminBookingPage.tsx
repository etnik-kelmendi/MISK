import { Navigate, useParams } from 'react-router';

/** Old links to one booking open it in the side panel of the bookings list. */
export function AdminBookingRedirect() {
  const { id = '' } = useParams();
  const valid = /^[0-9a-f-]{36}$/i.test(id);
  return <Navigate to={valid ? `/admin/bookings?open=b:${id}` : '/admin/bookings'} replace />;
}
