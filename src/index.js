import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { FluentProvider , teamsLightTheme } from "@fluentui/react-components";

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <FluentProvider theme={teamsLightTheme}>
    <App />
    </FluentProvider>
  </React.StrictMode>
);