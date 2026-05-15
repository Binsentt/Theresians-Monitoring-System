import React from 'react';
import '../../styles/components.css';

export function DataTable({ columns, data, className = '', emptyMessage = 'No data available' }) {
  return (
    <div className={`data-table-container ${className}`}>
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead className="data-table-header">
            <tr>
              {columns.map((column, index) => (
                <th key={index} className={`data-table-th ${column.className || ''}`}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="data-table-body">
            {data.length > 0 ? (
              data.map((row, rowIndex) => (
                <tr key={rowIndex} className="data-table-row">
                  {columns.map((column, colIndex) => (
                    <td key={colIndex} className={`data-table-td ${column.className || ''}`}>
                      {column.render ? column.render(row[column.key], row) : row[column.key]}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length} className="data-table-empty">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TableActions({ children }) {
  return (
    <div className="table-actions">
      {children}
    </div>
  );
}

export function TableFilters({ children, className = '' }) {
  return (
    <div className={`table-filters ${className}`}>
      {children}
    </div>
  );
}
