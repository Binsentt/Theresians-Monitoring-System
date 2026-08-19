import React from 'react';
import { getPasswordStrength, WEBSITE_PASSWORD_MIN_LENGTH } from '../utils/validation.utils';

export default function PasswordStrengthFeedback({ password }) {
  if (!password) return null;
  const { label, requirements } = getPasswordStrength(password);

  return (
    <div className={`password-strength password-strength-${label.toLowerCase()}`} aria-live="polite">
      <strong>Password Strength: {label}</strong>
      <span className={requirements.minimumLength ? 'password-requirement-met' : 'password-requirement-unmet'}>
        {requirements.minimumLength ? '✓' : '○'} At least {WEBSITE_PASSWORD_MIN_LENGTH} characters required
      </span>
    </div>
  );
}
