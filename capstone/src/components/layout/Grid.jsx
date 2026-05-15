import React from 'react';
import '../../styles/components.css';

export function Grid({ children, columns = 'auto-fit', minWidth = '300px', gap = '20px', className = '' }) {
  const gridStyle = {
    '--grid-columns': columns,
    '--grid-min-width': minWidth,
    '--grid-gap': gap,
  };

  return (
    <div
      className={`grid ${className}`}
      style={gridStyle}
    >
      {children}
    </div>
  );
}

export function FlexGrid({ children, columns = 3, gap = '20px', className = '' }) {
  return (
    <div
      className={`flex-grid ${className}`}
      style={{
        '--flex-columns': columns,
        '--flex-gap': gap,
      }}
    >
      {children}
    </div>
  );
}

export function ResponsiveGrid({ children, className = '', ...props }) {
  return (
    <Grid className={`responsive-grid ${className}`} {...props}>
      {children}
    </Grid>
  );
}
