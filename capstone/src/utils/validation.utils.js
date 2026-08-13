/**
 * Validation utilities for form fields
 */

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
