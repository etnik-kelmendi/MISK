import { Icon } from './Icon';

/**
 * The message under a field that is missing or wrong; its id matches the field's aria-describedby. With `alert`
 * it is read out at once and stands out more, for a field the person may not be looking at when they press send.
 */
export function FieldError({ id, message, alert = false }: { id: string; message: string | null; alert?: boolean }) {
  if (!message) {
    return null;
  }
  return (
    <span id={`${id}-error`} className={alert ? 'error-text error-box' : 'error-text'} {...(alert ? { role: 'alert' } : {})}>
      {alert && <Icon name="alert" />}
      {message}
    </span>
  );
}
