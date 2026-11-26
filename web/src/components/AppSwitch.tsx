import { Link } from 'react-router';
import { Icon } from './Icon';

/**
 * The button at the top of a profile page that opens the other app with the same account (D64, D103): "Switch
 * to Pro app" on the customer Profile of a pro, "Switch to Customer app" on the pro Profile.
 */
export function AppSwitch({ to, label, hint }: { to: string; label: string; hint: string }) {
  return (
    <Link to={to} className="card row app-switch">
      <span className="app-switch-icon" aria-hidden="true">
        <Icon name="repeat" />
      </span>
      <span className="grow">
        <span className="b block">{label}</span>
        <span className="tiny muted block">{hint}</span>
      </span>
      <Icon name="chevR" />
    </Link>
  );
}
