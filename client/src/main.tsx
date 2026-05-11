import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { Capacitor } from '@capacitor/core';

// Initialize mobile app if running on mobile
if (Capacitor.isNativePlatform()) {
  console.log('📱 Running on mobile platform');
  
  // Register service worker for PWA features
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('Service Worker registered:', registration);
      })
      .catch(error => {
        console.log('Service Worker registration failed:', error);
      });
  }
}

createRoot(document.getElementById("root")!).render(<App />);
