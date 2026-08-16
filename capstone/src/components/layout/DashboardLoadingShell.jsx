import React from 'react';
import AnalyticsSidebar from './AnalyticsSidebar';
import {
  DashboardContainer,
  MainContent,
  PageContent,
  TopBar,
} from './AppLayout';

/**
 * Keeps the dashboard chrome visible while a route loads its own data.
 * Authentication and each route's data request remain owned by the route.
 */
export default function DashboardLoadingShell({
  role = 'parent',
  activeItem,
  portalLabel,
  heading = 'Dashboard',
  subheading,
  logoSrc,
  onSelect,
}) {
  return (
    <DashboardContainer
      sidebar={(
        <AnalyticsSidebar
          role={role}
          activeItem={activeItem}
          portalLabel={portalLabel}
          logoSrc={logoSrc}
          onSelect={onSelect}
        />
      )}
      main={(
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>{heading}</h1>
              {subheading ? <p>{subheading}</p> : null}
            </div>
          </TopBar>
          <PageContent>
            <div
              className="dashboard-inline-loading"
              role="status"
              aria-label={`Loading ${heading}`}
            >
              <div className="dashboard-inline-skeleton dashboard-inline-skeleton-heading" />
              <div className="dashboard-inline-skeleton-grid" aria-hidden="true">
                <div className="dashboard-inline-skeleton dashboard-inline-skeleton-card" />
                <div className="dashboard-inline-skeleton dashboard-inline-skeleton-card" />
                <div className="dashboard-inline-skeleton dashboard-inline-skeleton-card" />
              </div>
              <div className="dashboard-inline-skeleton dashboard-inline-skeleton-panel" aria-hidden="true" />
            </div>
          </PageContent>
        </MainContent>
      )}
    />
  );
}
