'use client';

import { useEffect, useRef } from 'react';
import apiClient from './apiClient';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray.buffer as ArrayBuffer;
}

/**
 * Registers the service worker and subscribes to Web Push notifications.
 * Must be called after the user is authenticated (access token set).
 * Idempotent — repeated calls check if already subscribed before POSTing.
 */
export function usePushSubscription(enabled: boolean): void {
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (subscribedRef.current) return;
    if (!VAPID_PUBLIC_KEY) return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    let cancelled = false;

    (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        if (cancelled) return;

        // Check if already subscribed
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          subscribedRef.current = true;
          return;
        }

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        if (cancelled) return;

        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });

        const json = subscription.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;

        await apiClient.post('/push/subscribe', {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          userAgent: navigator.userAgent.slice(0, 200),
        });

        subscribedRef.current = true;
      } catch {
        // Non-critical — push is optional, never block the app
      }
    })();

    return () => { cancelled = true; };
  }, [enabled]);
}
