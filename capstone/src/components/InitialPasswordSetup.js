import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDefaultDashboardRoute, normalizeRole } from './manageUsers.utils';
import { getStoredUserSession } from './session.utils';

export default function InitialPasswordSetup() {
  const navigate = useNavigate();
  const user = getStoredUserSession();

  useEffect(() => {
    if (!user?.id) {
      navigate('/login', { replace: true });
      return;
    }
    navigate(getDefaultDashboardRoute(normalizeRole(user.role)), { replace: true });
  }, [navigate, user]);

  return null;
}
