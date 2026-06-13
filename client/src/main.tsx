import './polyfills';
import React from 'react';
import ReactDOM from 'react-dom/client';
import WalletApp from './WalletApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <WalletApp />
  </React.StrictMode>
);
