/** The message under a field that is missing or wrong; its id matches the field's aria-describedby. */
export function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <span id={`${id}-error`} className="error-text">
      {message}
    </span>
  );
}
