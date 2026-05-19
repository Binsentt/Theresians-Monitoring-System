import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

// Apply theme globally from localStorage so appearance persists across pages
const savedTheme = localStorage.getItem('theme') || 'light';
try {
	document.documentElement.setAttribute('data-theme', savedTheme);
} catch (e) {
	/* ignore during server-side or non-browser environments */
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
