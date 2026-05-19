const configuredApiBaseUrl = (process.env.REACT_APP_API_BASE_URL || '').replace(/\/$/, '');

export const apiUrl = (path) => {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
  return `${configuredApiBaseUrl}${normalizedPath}`;
};
