import { render, screen } from '@testing-library/react';
import { ApiError } from '../api/client';
import { isValidEmail, isValidPhone } from '../lib/checks';
import { ErrorText } from './ErrorText';

describe('error messages', () => {
  it('names the field the API refused', () => {
    render(<ErrorText error={new ApiError(400, 'validation_failed', 'postcode')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Please check "Postcode": it is missing or not in the right form.');
  });

  it('falls back to the general message for a field without a name', () => {
    render(<ErrorText error={new ApiError(400, 'validation_failed', 'somethingInternal')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Some of the details are not valid. Please check them.');
  });

  it('explains the API codes that had no message before', () => {
    render(<ErrorText error={new ApiError(409, 'no_open_problem')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('There is no open problem report on this booking');
  });

  it('tells a network problem from a refused request', () => {
    render(<ErrorText error={new TypeError('Failed to fetch')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('MISK could not be reached.');
  });
});

describe('format checks', () => {
  it('accepts the email addresses and phone numbers the API accepts', () => {
    expect(isValidEmail(' sara@example.com ')).toBe(true);
    expect(isValidEmail('sara@example')).toBe(false);
    expect(isValidPhone('+49 151 2345 6789')).toBe(true);
    expect(isValidPhone('0049 (151) 2345-6789')).toBe(true);
    expect(isValidPhone('0151 23456789')).toBe(false);
    expect(isValidPhone('+49 12')).toBe(false);
  });
});
