import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { Card, MetricCard, InfoCard } from './layout/Card';
import { ResponsiveGrid } from './layout/Grid';
import logoImage from '../assets/images/STS_Logo.png';
import { normalizeRole } from './manageUsers.utils';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders, getStoredUserSession, resolveAuthorizedSession } from './session.utils';
import { formatPercent, normalizeStudentProgressPayload } from './studentProgress.utils';

const hasRecordedResults = (student) => Number(
  student?.total_questions
  ?? student?.totalQuestions
  ?? student?.total_questions_answered
  ?? 0
) > 0;

export default function TeacherDashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [students, setStudents] = useState([]);
  const [overview, setOverview] = useState(null);
  const [topAchievers, setTopAchievers] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      try {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        const authorizedUser = resolveAuthorizedSession('teacher');
        if (!authorizedUser) {
          navigate('/login');
          return;
        }

        if (!cancelled) setUser(authorizedUser);
        const requestOptions = { headers: buildAuthHeaders() };
        const [studentsResult, overviewResult, achieversResult] = await Promise.allSettled([
          fetch(buildScopedApiUrl('/api/students/progress?lifecycle=active', authorizedUser.role), requestOptions),
          fetch(buildScopedApiUrl('/api/analytics/overview', authorizedUser.role), requestOptions),
          fetch(buildScopedApiUrl('/api/top-achievers', authorizedUser.role), requestOptions),
        ]);

        if (studentsResult.status !== 'fulfilled' || !studentsResult.value.ok) {
          throw new Error('Could not load the assigned student scope.');
        }

        const studentPayload = await studentsResult.value.json();
        const overviewPayload = overviewResult.status === 'fulfilled' && overviewResult.value.ok
          ? await overviewResult.value.json()
          : null;
        const achieversPayload = achieversResult.status === 'fulfilled' && achieversResult.value.ok
          ? await achieversResult.value.json()
          : [];

        if (cancelled) return;
        setStudents(normalizeStudentProgressPayload(studentPayload));
        setOverview(overviewPayload && typeof overviewPayload === 'object' ? overviewPayload : null);
        setTopAchievers(Array.isArray(achieversPayload) ? achieversPayload : []);
      } catch (err) {
        console.error('Failed to load teacher dashboard:', err);
        if (!cancelled) {
          setError('Unable to load the assigned student data right now.');
          setStudents([]);
          setOverview(null);
          setTopAchievers([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadData();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (loading) {
    const loadingRole = normalizeRole(getStoredUserSession()?.role);
    return (
      <DashboardLoadingShell
        role={loadingRole === 'parent_teacher' ? 'parent_teacher' : 'teacher'}
        activeItem="dashboard"
        logoSrc={logoImage}
        portalLabel="Teacher Portal"
        heading="Teacher Dashboard"
        subheading="Your classroom overview."
      />
    );
  }
  if (!user) return null;

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar 
          role={normalizeRole(user?.role) === 'parent_teacher' ? 'parent_teacher' : 'teacher'} 
          activeItem="dashboard" 
          logoSrc={logoImage}
          portalLabel="Teacher Portal" 
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div>
              <h1>Teacher Dashboard</h1>
              <p>Welcome, {user?.name || 'Teacher'}</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection>
              <ResponsiveGrid>
                <MetricCard
                  label="Assigned Students"
                  value={overview?.studentCount ?? students.length}
                  footer="Current authorized scope"
                />
                <MetricCard
                  label="Average Accuracy"
                  value={formatPercent(overview?.averageAccuracy, 'Not available')}
                  footer="Recorded current-cycle results"
                />
                <MetricCard
                  label="Average Completion"
                  value={formatPercent(overview?.averageProgress, 'Not available')}
                  footer="Current authorized scope"
                />
              </ResponsiveGrid>
            </ContentSection>

            <ContentSection
              title="Assigned Students"
              actions={<button className="btn-primary" type="button" onClick={() => navigate('/teacher/student-progress')}>View Student Progress</button>}
            >
              {error ? (
                <InfoCard variant="info"><p>{error}</p></InfoCard>
              ) : students.length === 0 ? (
                <InfoCard variant="info"><p>No assigned students are available yet.</p></InfoCard>
              ) : (
              <ResponsiveGrid minWidth="300px">
                {students.slice(0, 4).map((student) => (
                  <ClassroomStudentCard key={student.student_id || student.id} student={student} />
                ))}
              </ResponsiveGrid>
              )}
            </ContentSection>

            <ContentSection title="Current-cycle Highlights">
              {topAchievers.length === 0 ? (
                <InfoCard variant="info"><p>No current-cycle results are available yet.</p></InfoCard>
              ) : (
                <ResponsiveGrid minWidth="300px">
                  {topAchievers.slice(0, 3).map((student) => (
                    <ClassroomStudentCard key={student.student_id || student.id} student={student} highlight />
                  ))}
                </ResponsiveGrid>
              )}
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}

function ClassroomStudentCard({ student, highlight = false }) {
  const studentName = student.student_name || student.name || 'Student';
  const gradeAndSection = [student.grade_level || student.grade, student.section || 'Not assigned']
    .filter(Boolean)
    .join(' - ');

  return (
    <Card className="subject-card">
      <div className="subject-card-header">
        <h3>{studentName}</h3>
        {highlight && <span className="status-tag">Current cycle</span>}
      </div>
      <p className="subject-time">{gradeAndSection || 'Grade not assigned'}</p>
      {hasRecordedResults(student) ? (
        <p className="subject-prof">Accuracy: {formatPercent(student.performance_percentage ?? student.accuracy_rate, 'Not available')}</p>
      ) : (
        <p className="subject-prof">No activity yet</p>
      )}
    </Card>
  );
}
