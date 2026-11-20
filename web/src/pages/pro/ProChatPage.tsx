import { Navigate, useParams } from 'react-router';

/**
 * The old address of the pro's chat (D67), which notifications still link to: it now opens the Job page with
 * the "Chat with the customer" pop-up (D86).
 */
export function ProChatPage() {
  const { id = '' } = useParams();
  return <Navigate to={`/pro/jobs/${encodeURIComponent(id)}?sheet=chat`} replace />;
}
