import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, UserCheck, GraduationCap } from 'lucide-react';
import logoImage from '../assets/images/STS_Logo.png';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { ResponsiveGrid } from './layout/Grid';
import { DataTable } from './layout/Table';
import { MetricCard, InfoCard } from './layout/Card';
import { formatRoleLabel, isParentRole, isTeacherRole, normalizeRole } from './manageUsers.utils';
import { apiUrl } from '../api';
import { buildAuthHeaders } from './session.utils';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { formatReportContext, formatTableRange, matchesTableSearch, paginateTableRows } from './tableReporting.utils';
import '../styles/admindashboard.css';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [presence, setPresence] = useState(null);

  const loadPresence = useCallback(async () => {
    try {
      const response = await fetch(apiUrl('/api/admin/presence'), { headers: buildAuthHeaders() });
      if (!response.ok) throw new Error('Presence unavailable');
      const payload = await response.json();
      const onlineNow = payload?.online_now;
      if (!onlineNow || !Number.isFinite(Number(onlineNow.total))) throw new Error('Invalid presence response');
      setPresence(onlineNow);
    } catch (error) {
      setPresence(null);
    }
  }, []);

  useEffect(() => {
    const loadData = async () => {
      try {
        // Load and apply theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (!loggedInUser || normalizeRole(loggedInUser.role) !== 'admin') {
          navigate('/login');
          return;
        }


        try {
          const userResponse = await fetch(apiUrl(`/api/user/${loggedInUser.id}`), {
            headers: buildAuthHeaders(),
          });
          if (userResponse.ok) {
            const freshUserData = await userResponse.json();
            delete freshUserData.password;
            setUser(freshUserData);
            localStorage.setItem('loggedInUser', JSON.stringify(freshUserData));
          } else {
            setUser(loggedInUser);
          }
        } catch (err) {
          console.error('Failed to fetch fresh user data:', err);
          setUser(loggedInUser);
        }

        const response = await fetch(apiUrl('/api/accounts'), { headers: buildAuthHeaders() });
        if (response.ok) {
          const allAccounts = await response.json();

          // Filter to show only non-admin users (parents and teachers)
          const filteredUsers = allAccounts.filter(acc =>
            acc.role?.toLowerCase() !== 'admin'
          );
          setUsers(filteredUsers);
        }
        await loadPresence();
      } catch (error) {
        console.error('Error fetching data:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [loadPresence, navigate]);

  useEffect(() => {
    const refreshPresence = () => {
      if (document.visibilityState !== 'hidden') loadPresence();
    };
    const intervalId = window.setInterval(refreshPresence, 30_000);
    document.addEventListener('visibilitychange', refreshPresence);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refreshPresence);
    };
  }, [loadPresence]);

  const filteredRecentUsers = useMemo(() => users
    .slice()
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))
    .filter((account) => matchesTableSearch(account, userSearch, [
      'name', 'email', 'role', 'employee_id', 'parent_id',
    ])), [userSearch, users]);
  const paginatedRecentUsers = paginateTableRows(filteredRecentUsers, userPage, 5);

  useEffect(() => {
    setUserPage(1);
  }, [userSearch]);

  useEffect(() => {
    if (userPage !== paginatedRecentUsers.currentPage) setUserPage(paginatedRecentUsers.currentPage);
  }, [paginatedRecentUsers.currentPage, userPage]);

  const recentUserReportColumns = [
    { header: 'No.', value: (_, index) => index + 1 },
    { header: 'User Name', value: (row) => row.name || 'No name set' },
    { header: 'Email', value: (row) => row.email || '-' },
    { header: 'Role', value: (row) => formatRoleLabel(row.role || 'Parent') },
    { header: 'School ID', value: (row) => row.employee_id || row.parent_id || '-' },
  ];

  const handleSidebarSelection = (key) => {
    switch (key) {
      case 'dashboard':
        break;  // Stay on dashboard
      case 'manage-users':
        navigate('/manage-users');
        break;
      case 'archived-users':
        navigate('/manage-users');
        break;
      case 'top-achievers':
        navigate('/admin/top-achievers');
        break;
      case 'activity-log':
        navigate('/admin/activity-log');
        break;
      default:
        break;
    }
  };

  if (loading) {
    return (
      <DashboardLoadingShell
        role="admin"
        activeItem="dashboard"
        onSelect={handleSidebarSelection}
        logoSrc={logoImage}
        portalLabel="Admin Portal"
        heading="Admin Dashboard"
        subheading="Your school management overview."
      />
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role="admin"
          activeItem="dashboard"
          onSelect={handleSidebarSelection}
          logoSrc={logoImage}
          portalLabel="Admin Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div>
              <h1>Admin Dashboard</h1>
              <p>Welcome, {user?.full_name || 'Administrator'}</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection>
              <ResponsiveGrid>
                <MetricCard
                  label="Registered / Enabled"
                  value={users.length}
                  footer="Parents & Teachers"
                  icon={<Users size={24} />}
                />
                <MetricCard
                  label="Online Now"
                  value={presence ? presence.total : 'Unavailable'}
                  footer={presence
                    ? `${presence.teachers || 0} teachers · ${presence.parents || 0} parents`
                    : 'Presence could not be retrieved'}
                  icon={<Users size={24} />}
                />
                <MetricCard
                  label="Parents"
                  value={users.filter(u => isParentRole(u.role)).length}
                  footer="Active accounts"
                  icon={<UserCheck size={24} />}
                />
                <MetricCard
                  label="Teachers"
                  value={users.filter(u => isTeacherRole(u.role)).length}
                  footer="Active accounts"
                  icon={<GraduationCap size={24} />}
                />
              </ResponsiveGrid>
            </ContentSection>

            <ContentSection>
              <InfoCard variant="info">
                <strong>System Reminder</strong>
                <p>Manage parent and teacher accounts from the Users section. Monitor system activity and analytics from dedicated pages.</p>
              </InfoCard>
            </ContentSection>

            <ContentSection
              title="Recent Users"
              actions={(
                <div className="table-report-controls">
                  <TablePrintButton
                    reportTitle="Registered Parent and Teacher Accounts"
                    reportContext={formatReportContext({ scope: userSearch ? `Search: ${userSearch}` : 'All enabled accounts', recordCount: filteredRecentUsers.length })}
                    label="Print User List"
                    showPrintHeading={false}
                  />
                  <button className="btn-primary" onClick={() => navigate('/manage-users')}>View All Users</button>
                </div>
              )}
            >
              <div className="filter-group filter-search no-print">
                <label htmlFor="admin-dashboard-user-search">Search users</label>
                <input
                  id="admin-dashboard-user-search"
                  type="search"
                  value={userSearch}
                  onChange={(event) => setUserSearch(event.target.value)}
                  placeholder="Name, email, role, or school ID"
                />
              </div>
              <DataTable
                columns={[
                  {
                    key: 'name',
                    header: 'User Name',
                    className: 'recent-user-name-col',
                    render: (value, row) => (
                      <div className="recent-user-name-cell">
                        <div className="recent-user-avatar">
                          {(value || row.email)?.charAt(0).toUpperCase()}
                        </div>
                        <span className="recent-user-name-text">{value || 'No name set'}</span>
                      </div>
                    )
                  },
                  { key: 'email', header: 'Email', className: 'recent-user-email-col' },
                  {
                    key: 'role',
                    header: 'Role',
                    className: 'recent-user-role-col',
                    render: (value) => (
                      <span className={`recent-user-role-badge ${normalizeRole(value) === 'teacher' ? 'teacher' : 'parent'}`}>
                        {formatRoleLabel(value || 'Parent')}
                      </span>
                    )
                  }
                ]}
                data={paginatedRecentUsers.rows}
                emptyMessage="No users found. Add your first user!"
              />
              <div className="pagination-row no-print">
                <span>{formatTableRange(paginatedRecentUsers)}</span>
                <button type="button" onClick={() => setUserPage((value) => Math.max(1, value - 1))} disabled={paginatedRecentUsers.currentPage === 1}>Previous</button>
                <span>Page {paginatedRecentUsers.currentPage} of {paginatedRecentUsers.totalPages}</span>
                <button type="button" onClick={() => setUserPage((value) => Math.min(paginatedRecentUsers.totalPages, value + 1))} disabled={paginatedRecentUsers.currentPage === paginatedRecentUsers.totalPages}>Next</button>
              </div>
              <PrintableTableReport
                title="Registered Parent and Teacher Accounts"
                context={userSearch ? `Search: ${userSearch}` : 'All enabled accounts'}
                rows={filteredRecentUsers}
                columns={recentUserReportColumns}
              />
            </ContentSection>

            <ContentSection
              title="Analytics"
              actions={
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button className="btn-primary" onClick={() => navigate('/admin/top-achievers')}>View Top Achievers</button>
                  <button className="btn-primary" onClick={() => navigate('/admin/activity-log')}>View Activity Log</button>
                </div>
              }
            >
              <InfoCard variant="info">
                <p>Access detailed analytics for Top Achievers and Recent Activity through dedicated pages for comprehensive system monitoring.</p>
              </InfoCard>
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
