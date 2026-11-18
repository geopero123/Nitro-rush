import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();

export function haptic(kind = 'light') {
  try {
    const style = kind === 'heavy' ? ImpactStyle.Heavy : kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light;
    Haptics.impact({ style }).catch(() => {});
  } catch (e) { /* ignore */ }
}

export function initNative({ onBack, onPause, onResume }) {
  if (!isNative) return;
  try {
    App.addListener('backButton', onBack);
    App.addListener('pause', onPause);
    App.addListener('resume', onResume);
  } catch (e) { /* ignore */ }
}

export function exitApp() { try { App.exitApp(); } catch (e) { /* ignore */ } }
