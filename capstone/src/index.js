import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

const LOCAL_API_ORIGIN = 'http://localhost:5000';
const configuredApiBaseUrl = (process.env.REACT_APP_API_BASE_URL || '').replace(/\/$/, '');
const shouldUseProductionApi =
	window.location.hostname !== 'localhost' &&
	window.location.hostname !== '127.0.0.1';

if (shouldUseProductionApi && window.fetch) {
	const nativeFetch = window.fetch.bind(window);
	window.fetch = (input, init) => {
		if (typeof input === 'string' && input.startsWith(LOCAL_API_ORIGIN)) {
			const path = input.slice(LOCAL_API_ORIGIN.length);
			return nativeFetch(`${configuredApiBaseUrl}${path}`, init);
		}

		if (input instanceof Request && input.url.startsWith(LOCAL_API_ORIGIN)) {
			const path = input.url.slice(LOCAL_API_ORIGIN.length);
			return nativeFetch(new Request(`${configuredApiBaseUrl}${path}`, input), init);
		}

		return nativeFetch(input, init);
	};
}

// Apply theme globally from localStorage so appearance persists across pages
const savedTheme = localStorage.getItem('theme') || 'light';
try {
	document.documentElement.setAttribute('data-theme', savedTheme);
} catch (e) {
	/* ignore during server-side or non-browser environments */
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
