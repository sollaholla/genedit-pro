import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DownloadPage } from './components/download/DownloadPage';
import './styles/globals.css';

const Root = isDownloadRoute() ? DownloadPage : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

function isDownloadRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, '');
  return pathname.endsWith('/download');
}
