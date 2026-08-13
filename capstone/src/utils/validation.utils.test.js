import { validateEmail, validatePassword, validateOtp } from './validation.utils';

describe('validation.utils', () => {
  describe('validateEmail', () => {
    test('returns error for empty email', () => {
      const result = validateEmail('');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Email is required.');
    });

    test('returns error for email with only spaces', () => {
      const result = validateEmail('   ');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Email is required.');
    });

    test('returns error for invalid email format - missing domain', () => {
      const result = validateEmail('vincent@');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid email address.');
    });

    test('returns error for invalid email format - missing local part', () => {
      const result = validateEmail('@gmail.com');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid email address.');
    });

    test('returns error for invalid email format - missing @', () => {
      const result = validateEmail('vincent.gmail.com');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid email address.');
    });

    test('returns error for invalid email format - missing TLD', () => {
      const result = validateEmail('vincent@gmail');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid email address.');
    });

    test('returns error for invalid email format - only local part', () => {
      const result = validateEmail('vincent');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid email address.');
    });

    test('returns valid for correct email format', () => {
      const result = validateEmail('vincent@example.com');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('returns valid for email with subdomain', () => {
      const result = validateEmail('vincent@mail.example.com');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('returns valid for email with multiple subdomains', () => {
      const result = validateEmail('vincent@mail.company.example.com');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('returns valid for email with hyphen in local part', () => {
      const result = validateEmail('vincent-john@example.com');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('returns valid for email with numbers in local part', () => {
      const result = validateEmail('vincent123@example.com');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('trims whitespace from email', () => {
      const result = validateEmail('  vincent@example.com  ');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });
  });

  describe('validatePassword', () => {
    test('returns error for empty password', () => {
      const result = validatePassword('');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Password is required.');
    });

    test('returns error for password with only spaces', () => {
      const result = validatePassword('   ');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Password is required.');
    });

    test('returns valid for non-empty password', () => {
      const result = validatePassword('MyPassword123!');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('returns valid for short password (no length requirement)', () => {
      const result = validatePassword('abc');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('returns valid for long password', () => {
      const result = validatePassword('MyVeryLongPasswordWith123SpecialCharacters!@#$%');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });
  });

  describe('validateOtp', () => {
    test('returns error for empty OTP', () => {
      const result = validateOtp('');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('OTP is required.');
    });

    test('returns error for OTP with only spaces', () => {
      const result = validateOtp('   ');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('OTP is required.');
    });

    test('returns error for OTP with less than 6 digits', () => {
      const result = validateOtp('12345');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('OTP must be 6 digits.');
    });

    test('returns error for OTP with more than 6 digits', () => {
      const result = validateOtp('1234567');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('OTP must be 6 digits.');
    });

    test('returns error for OTP with non-digit characters', () => {
      const result = validateOtp('12345a');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('OTP must be 6 digits.');
    });

    test('returns error for OTP with special characters', () => {
      const result = validateOtp('123-456');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('OTP must be 6 digits.');
    });

    test('returns valid for 6-digit OTP', () => {
      const result = validateOtp('123456');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('returns valid for OTP with all zeros', () => {
      const result = validateOtp('000000');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });

    test('returns valid for OTP with all nines', () => {
      const result = validateOtp('999999');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeNull();
    });
  });
});
