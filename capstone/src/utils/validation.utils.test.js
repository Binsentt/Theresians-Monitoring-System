import {
  getPasswordStrength,
  PARENT_CHILD_GRADE_OPTIONS,
  PARENT_CHILD_SECTION_OPTIONS_BY_GRADE,
  validateChildProfile,
  validateEmail,
  validateGameStudentId,
  validatePhilippineMobile,
  validatePassword,
  validateOtp,
} from './validation.utils';

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

  describe('validatePhilippineMobile', () => {
    test('accepts a blank optional mobile number as null', () => {
      expect(validatePhilippineMobile('   ')).toEqual({
        isValid: true,
        value: null,
        error: null,
      });
    });

    test('accepts a local eleven-digit Philippine mobile number', () => {
      expect(validatePhilippineMobile('09171234567')).toEqual({
        isValid: true,
        value: '09171234567',
        error: null,
      });
    });

    test.each(['9171234567', '08171234567', '0917123456', '091712345678', '0917-123-4567', '+639171234567'])(
      'rejects unsupported mobile input %s',
      (value) => {
        expect(validatePhilippineMobile(value)).toEqual({
          isValid: false,
          value: null,
          error: 'Mobile number must be in the format 09XXXXXXXXX.',
        });
      }
    );
  });

  describe('validateGameStudentId', () => {
    test('keeps a six-digit Game Student ID as a string with leading zeroes', () => {
      expect(validateGameStudentId('001234')).toEqual({
        isValid: true,
        value: '001234',
        error: null,
      });
    });

    test.each(['', '12345', '1234567', 'ABC123', '123.456'])('rejects invalid Student ID %s', (value) => {
      expect(validateGameStudentId(value)).toEqual({
        isValid: false,
        value: null,
        error: value === '' ? 'Student ID is required.' : 'Student ID must be exactly 6 digits.',
      });
    });
  });

  describe('getPasswordStrength', () => {
    test('never marks a password below the backend minimum as acceptable', () => {
      expect(getPasswordStrength('short')).toMatchObject({ label: 'Weak', meetsPolicy: false });
    });

    test('labels a policy-valid baseline password as Medium', () => {
      expect(getPasswordStrength('twelvechars!')).toMatchObject({ label: 'Medium', meetsPolicy: true });
    });

    test('labels a longer, varied policy-valid password as Strong', () => {
      expect(getPasswordStrength('LongerSecurePassword42!')).toMatchObject({ label: 'Strong', meetsPolicy: true });
    });
  });

  describe('validateChildProfile', () => {
    test('requires first name, last name, Grade, and Student ID while keeping Section optional', () => {
      expect(validateChildProfile({
        firstName: ' ',
        lastName: '',
        middleInitial: '',
        gradeLevel: '',
        section: '',
        studentId: '',
      })).toEqual({
        firstName: 'First name is required.',
        lastName: 'Last name is required.',
        gradeLevel: 'Grade is required.',
        studentId: 'Student ID is required.',
      });
    });

    test('accepts a normalized school Section label and preserves a leading-zero Student ID', () => {
      expect(validateChildProfile({
        firstName: 'Ava',
        lastName: 'Santos',
        middleInitial: 'M',
        gradeLevel: 'Grade 3',
        section: 'Rizal',
        studentId: '001234',
      })).toEqual({});
      expect(PARENT_CHILD_GRADE_OPTIONS).toEqual(['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6']);
      expect(PARENT_CHILD_SECTION_OPTIONS_BY_GRADE['Grade 1']).toEqual(['Section A', 'Section B']);
      expect(PARENT_CHILD_SECTION_OPTIONS_BY_GRADE['Grade 3']).toEqual(['Section A', 'Section B', 'Section C']);
    });

    test('rejects an invalid middle initial, malformed Section, and malformed Student ID', () => {
      expect(validateChildProfile({
        firstName: 'Ava',
        lastName: 'Santos',
        middleInitial: 'MM',
        gradeLevel: 'Grade 3',
        section: 'Rizal!',
        studentId: '12345',
      })).toEqual({
        middleInitial: 'Middle initial must be one letter.',
        section: 'Section may only contain letters, numbers, spaces, periods, apostrophes, or hyphens.',
        studentId: 'Student ID must be exactly 6 digits.',
      });
    });

    test('keeps existing grade-specific Section values as suggestions without rejecting a valid school section', () => {
      expect(validateChildProfile({
        firstName: 'Ava',
        lastName: 'Santos',
        gradeLevel: 'Grade 1',
        section: 'Section C',
        studentId: '001234',
      })).toEqual({});
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
