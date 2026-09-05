/**
 * Validation utilities for form fields
 */

export const WEBSITE_PASSWORD_MIN_LENGTH = 8;
export const PARENT_CHILD_GRADE_OPTIONS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];

export const validateSchoolSection = (value, { required = false } = {}) => {
  const section = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!section) return required ? 'Section is required.' : null;
  if (section.length > 50) return 'Section must be 50 characters or fewer.';
  if (!/^[A-Za-z0-9][A-Za-z0-9 .'-]*$/.test(section)) {
    return 'Section may only contain letters, numbers, spaces, periods, apostrophes, or hyphens.';
  }
  return null;
};

export const validatePhilippineMobile = (value) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return { isValid: true, value: null, error: null };
  }
  if (!/^09\d{9}$/.test(normalized)) {
    return {
      isValid: false,
      value: null,
      error: 'Mobile number must be in the format 09XXXXXXXXX.',
    };
  }
  return { isValid: true, value: normalized, error: null };
};

export const validatePhilippineMobileUpdate = (value, originalValue) => {
  if (value === originalValue) {
    return { isValid: true, value, error: null };
  }
  return validatePhilippineMobile(value);
};

export const validateGameStudentId = (value) => {
  const normalized = String(value ?? '');
  if (!normalized) {
    return { isValid: false, value: null, error: 'Student ID is required.' };
  }
  if (!/^[0-9]{6}$/.test(normalized) && !/^[0-9]{8}$/.test(normalized)) {
    return { isValid: false, value: null, error: 'Student ID must be either 6 or 8 digits.' };
  }
  return { isValid: true, value: normalized, error: null };
};

export const getPasswordStrength = (value) => {
  const password = typeof value === 'string' ? value : String(value ?? '');
  const requirements = {
    minimumLength: password.length >= WEBSITE_PASSWORD_MIN_LENGTH,
    lowercase: /[a-z]/.test(password),
    uppercase: /[A-Z]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
  };
  const meetsPolicy = requirements.minimumLength;
  const hasLettersAndNumber = (requirements.lowercase || requirements.uppercase) && requirements.number;
  const hasStrongComposition = requirements.lowercase
    && requirements.uppercase
    && requirements.number
    && requirements.symbol;
  const label = password.length < 6
    ? 'Very Weak'
    : password.length < WEBSITE_PASSWORD_MIN_LENGTH
      ? 'Weak'
      : hasStrongComposition && password.length >= 12
        ? 'Very Strong'
        : hasStrongComposition
          ? 'Strong'
          : hasLettersAndNumber
            ? 'Fair'
            : 'Weak';
  return { label, meetsPolicy, requirements };
};

export const validateNewWebsitePassword = (password) => {
  if (typeof password !== 'string' || password.length < WEBSITE_PASSWORD_MIN_LENGTH) {
    return {
      isValid: false,
      error: `Password must be at least ${WEBSITE_PASSWORD_MIN_LENGTH} characters.`,
    };
  }
  return { isValid: true, error: null };
};

const validateChildName = (value, label, { required = false, initial = false } = {}) => {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) return required ? `${label} is required.` : null;
  const initialValue = initial ? normalized.replace(/\.$/, '') : normalized;
  if (initial && !/^[A-Za-z]$/.test(initialValue)) return 'Middle initial must be one letter.';
  if (!initial && !/^[A-Za-z][A-Za-z' -]*$/.test(initialValue)) {
    return `${label} may only contain letters, spaces, apostrophes, or hyphens.`;
  }
  return null;
};

export const validateChildProfile = ({
  firstName,
  lastName,
  middleInitial,
  gradeLevel,
  section,
  studentId,
  sectionOptions = [],
} = {}) => {
  const errors = {};
  const firstNameError = validateChildName(firstName, 'First name', { required: true });
  const lastNameError = validateChildName(lastName, 'Last name', { required: true });
  const middleInitialError = validateChildName(middleInitial, 'Middle initial', { initial: true });
  if (firstNameError) errors.firstName = firstNameError;
  if (lastNameError) errors.lastName = lastNameError;
  if (middleInitialError) errors.middleInitial = middleInitialError;

  if (!String(gradeLevel || '').trim()) errors.gradeLevel = 'Grade is required.';
  else if (!PARENT_CHILD_GRADE_OPTIONS.includes(gradeLevel)) errors.gradeLevel = 'Select an available Grade.';
  const sectionError = validateSchoolSection(section, { required: true });
  if (sectionError) errors.section = sectionError;
  else if (Array.isArray(sectionOptions) && sectionOptions.length > 0 && !sectionOptions.includes(String(section).trim())) {
    errors.section = 'Select a Section available for the chosen Grade.';
  }

  const studentIdResult = validateGameStudentId(studentId);
  if (!studentIdResult.isValid) errors.studentId = studentIdResult.error;
  return errors;
};

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {object} { isValid: boolean, error: string|null }
 */
export const validateEmail = (email) => {
  if (!email || email.trim() === '') {
    return {
      isValid: false,
      error: 'Email is required.',
    };
  }

  // RFC 5322 simplified regex for email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  if (!emailRegex.test(email.trim())) {
    return {
      isValid: false,
      error: 'Please enter a valid email address.',
    };
  }

  return {
    isValid: true,
    error: null,
  };
};

/**
 * Validate password (check if empty)
 * @param {string} password - Password to validate
 * @returns {object} { isValid: boolean, error: string|null }
 */
export const validatePassword = (password) => {
  if (!password || password.trim() === '') {
    return {
      isValid: false,
      error: 'Password is required.',
    };
  }

  return {
    isValid: true,
    error: null,
  };
};

/**
 * Validate OTP (check if empty and valid format)
 * @param {string} otp - OTP to validate
 * @returns {object} { isValid: boolean, error: string|null }
 */
export const validateOtp = (otp) => {
  if (!otp || otp.trim() === '') {
    return {
      isValid: false,
      error: 'OTP is required.',
    };
  }

  // OTP should be 6 digits
  if (!/^\d{6}$/.test(otp)) {
    return {
      isValid: false,
      error: 'OTP must be 6 digits.',
    };
  }

  return {
    isValid: true,
    error: null,
  };
};
