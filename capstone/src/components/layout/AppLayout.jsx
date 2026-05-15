import React from 'react';
import '../../styles/layout.css';

export default function AppLayout({ children, className = '' }) {
  return (
    <div className={`app-layout ${className}`}>
      {children}
    </div>
  );
}

export function DashboardContainer({ sidebar, main, className = '' }) {
  return (
    <div className={`dashboard-container ${className}`}>
      {sidebar}
      {main}
    </div>
  );
}

export function MainContent({ children, className = '' }) {
  return (
    <main className={`main-content ${className}`}>
      {children}
    </main>
  );
}

export function PageContent({ children, className = '' }) {
  return (
    <div className={`page-content ${className}`}>
      {children}
    </div>
  );
}

export function TopBar({ children, className = '' }) {
  return (
    <header className={`top-bar ${className}`}>
      {children}
    </header>
  );
}

export function ContentSection({ children, className = '', contentClassName = '', title, actions }) {
  return (
    <section className={`content-section ${className}`}>
      {(title || actions) && (
        <div className="section-header">
          {title && <h2 className="section-title">{title}</h2>}
          {actions && <div className="section-actions">{actions}</div>}
        </div>
      )}
      <div className={`section-content ${contentClassName}`}>
        {children}
      </div>
    </section>
  );
}
