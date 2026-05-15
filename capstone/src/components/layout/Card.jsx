import React from 'react';
import '../../styles/components.css';

export function Card({ children, className = '', variant = 'default', hover = true, ...props }) {
  return (
    <div
      className={`card card-${variant} ${hover ? 'card-hover' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function MetricCard({ label, value, footer, icon, trend, className = '' }) {
  return (
    <Card className={`metric-card ${className}`}>
      <div className="metric-header">
        {icon && <div className="metric-icon">{icon}</div>}
        <div className="metric-label">{label}</div>
      </div>
      <div className="metric-value">
        {value}
        {trend && <span className={`metric-trend ${trend.type}`}>{trend.value}</span>}
      </div>
      {footer && <div className="metric-footer">{footer}</div>}
    </Card>
  );
}

export function InfoCard({ title, children, variant = 'info', className = '' }) {
  return (
    <Card className={`info-card info-${variant} ${className}`}>
      {title && <h3 className="info-title">{title}</h3>}
      <div className="info-content">
        {children}
      </div>
    </Card>
  );
}

export function StatsCard({ title, stats, className = '' }) {
  return (
    <Card className={`stats-card ${className}`}>
      <h3 className="stats-title">{title}</h3>
      <div className="stats-grid">
        {stats.map((stat, index) => (
          <div key={index} className="stat-item">
            <div className="stat-value">{stat.value}</div>
            <div className="stat-label">{stat.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
