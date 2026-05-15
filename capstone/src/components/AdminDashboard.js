import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, UserCheck, GraduationCap } from 'lucide-react';
import logoImage from '../assets/images/STS_Logo.png';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { ResponsiveGrid } from './layout/Grid';
import { DataTable } from './layout/Table';
import { MetricCard, InfoCard } from './layout/Card';
import '../styles/admindashboard.css';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      try {
        // Load and apply theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (!loggedInUser || loggedInUser.role !== 'admin') {
          navigate('/login');
          return;
        }


        try {
          const userResponse = await fetch(`http://localhost:5000/api/user/${loggedInUser.id}`);
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

        const response = await fetch('http://localhost:5000/api/accounts');
        if (response.ok) {
          const allAccounts = await response.json();

          // Filter to show only non-admin users (parents and teachers)
          const filteredUsers = allAccounts.filter(acc =>
            acc.role?.toLowerCase() !== 'admin'
          );
          setUsers(filteredUsers);
        }
      } catch (error) {
        console.error('Error fetching data:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [navigate]);

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
      <div className="sts-loader-container">
        <div className="sts-spinner"></div>
        <p>Loading Admin Portal...</p>
      </div>
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
                  label="Total Users"
                  value={users.length}
                  footer="Parents & Teachers"
                  icon={<Users size={24} />}
                />
                <MetricCard
                  label="Parents"
                  value={users.filter(u => u.role?.toLowerCase() === 'parent').length}
                  footer="Active accounts"
                  icon={<UserCheck size={24} />}
                />
                <MetricCard
                  label="Teachers"
                  value={users.filter(u => u.role?.toLowerCase() === 'teacher').length}
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
              actions={<button className="btn-primary" onClick={() => navigate('/manage-users')}>View All Users</button>}
            >
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
                      <span className={`recent-user-role-badge ${value?.toLowerCase() === 'teacher' ? 'teacher' : 'parent'}`}>
                        {value || 'Parent'}
                      </span>
                    )
                  }
                ]}
                data={users.slice(-5).reverse()}
                emptyMessage="No users found. Add your first user!"
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
