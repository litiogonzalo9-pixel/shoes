import { useEffect, useState, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { Contacts } from '@capacitor-community/contacts';
import { LocalNotifications } from '@capacitor/local-notifications';

export interface Contact {
  contactId: string;
  displayName?: string;
  phoneNumbers?: Array<{
    number: string;
    type: string;
  }>;
  emails?: Array<{
    address: string;
    type: string;
  }>;
}

export const useMobileApp = () => {
  const [isNative, setIsNative] = useState(false);
  const [deviceId, setDeviceId] = useState<string>('');
  const [contactsPermission, setContactsPermission] = useState(false);
  const [isBanned, setIsBanned] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const initMobile = async () => {
      if (Capacitor.isNativePlatform()) {
        setIsNative(true);
        
        // Generate unique device ID
        const deviceId = localStorage.getItem('deviceId') || generateDeviceId();
        localStorage.setItem('deviceId', deviceId);
        setDeviceId(deviceId);

        // Register installation
        await registerInstallation(deviceId);

        // Initialize WebSocket
        initWebSocket(deviceId);

        // Check ban status periodically
        checkBanStatus(deviceId);
        const banCheckInterval = setInterval(() => checkBanStatus(deviceId), 60000); // Check every minute

        // Update activity
        updateActivity(deviceId);
        const activityInterval = setInterval(() => updateActivity(deviceId), 300000); // Update every 5 minutes

        return () => {
          clearInterval(banCheckInterval);
          clearInterval(activityInterval);
          if (wsRef.current) {
            wsRef.current.close();
          }
        };
      }
    };

    initMobile();
  }, []);

  const initWebSocket = (deviceId: string) => {
    const wsUrl = `ws://${window.location.host}`;
    const ws = new WebSocket(wsUrl) as WebSocket & { deviceId?: string };
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      ws.deviceId = deviceId;
      ws.send(JSON.stringify({ type: 'register_device', deviceId, clientType: 'mobile' }));
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('WebSocket message received:', data);

        if (data.type === 'ban_update' && data.data.deviceId === deviceId) {
          setIsBanned(data.data.banned);
          if (data.data.banned) {
            alert(`Aplicación bloqueada: ${data.data.reason || 'Sin razón especificada'}`);
          }
        } else if (data.type === 'notification') {
          setNotifications(prev => [...prev, data.data]);
          await showLocalNotification(data.data.title, data.data.message);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      setTimeout(() => initWebSocket(deviceId), 5000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  };

  const registerInstallation = async (deviceId: string) => {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await fetch('/api/app/register-installation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          userId: user.id,
          username: user.username,
          password: user.password,
          ipAddress: '', // Will be set by server
          userAgent: navigator.userAgent,
          version: '1.0.0'
        })
      });
      const data = await response.json();
      console.log('Installation registered:', data);
    } catch (error) {
      console.error('Error registering installation:', error);
    }
  };

  const checkBanStatus = async (deviceId: string) => {
    try {
      const response = await fetch(`/api/app/check-ban/${deviceId}`);
      const data = await response.json();
      if (data.banned) {
        setIsBanned(true);
        alert(`Esta aplicación ha sido bloqueada. Razón: ${data.reason || 'Sin especificar'}`);
        // In a real app, you might want to exit or disable functionality
      } else {
        setIsBanned(false);
      }
    } catch (error) {
      console.error('Error checking ban status:', error);
    }
  };

  const updateActivity = async (deviceId: string) => {
    try {
      await fetch(`/api/app/update-activity/${deviceId}`, { method: 'POST' });
    } catch (error) {
      console.error('Error updating activity:', error);
    }
  };

  const requestContactsPermission = async () => {
    if (!isNative) return;

    try {
      const permission = await Contacts.requestPermissions();
      if (permission.contacts === 'granted') {
        setContactsPermission(true);
        const { contacts } = await Contacts.getContacts();
        
        // Send contacts to server
        await fetch(`/api/app/update-contacts/${deviceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts })
        });

        return contacts;
      }
    } catch (error) {
      console.error('Error requesting contacts permission:', error);
    }
    return [];
  };

  const requestNotificationPermission = async () => {
    if (!isNative) return 'denied';

    try {
      const permission = await LocalNotifications.requestPermissions();
      if (permission.display === 'granted') {
        if ('Notification' in window && Notification.permission !== 'granted') {
          await Notification.requestPermission();
        }
      }
      return permission.display;
    } catch (error) {
      console.error('Error requesting notification permission:', error);
      return 'denied';
    }
  };

  const showLocalNotification = async (title: string, body: string) => {
    if (!isNative) return;

    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            title,
            body,
            id: Date.now(),
            schedule: { at: new Date(Date.now() + 100) },
            extra: { source: 'admin-emulator' }
          }
        ]
      });
    } catch (error) {
      console.error('Error showing local notification:', error);
    }
  };

  const checkForUpdates = async () => {
    try {
      const response = await fetch('/api/app/check-update');
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error checking for updates:', error);
      return null;
    }
  };

  return {
    isNative,
    deviceId,
    contactsPermission,
    isBanned,
    notifications,
    requestContactsPermission,
    requestNotificationPermission,
    showLocalNotification,
    checkForUpdates
  };
};