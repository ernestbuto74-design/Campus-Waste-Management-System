/**
 * firebase-config.js
 * ---------------------------------------------------------------------------
 * Initializes Firebase App, Auth, and Cloud Firestore (modular SDK).
 *
 * STANDALONE DEPLOYMENT INSTRUCTIONS:
 * If you deploy this project outside AI Studio with your own Firebase project:
 *   1. Open the Firebase Console -> Project Settings -> Your Apps -> Web App.
 *   2. Copy your `firebaseConfig` object (`apiKey`, `authDomain`, `projectId`,
 *      `storageBucket`, `messagingSenderId`, `appId`).
 *   3. Replace `firebaseAppletConfig` below with your project's config object,
 *      and set `firestoreDatabaseId` to `"(default)"` (or omit it) if using the
 *      default Firestore database.
 * ---------------------------------------------------------------------------
 */

import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, initializeFirestore } from 'firebase/firestore';
import firebaseAppletConfig from '../firebase-applet-config.json';

export const firebaseConfig = firebaseAppletConfig;

if (!firebaseConfig?.projectId || !firebaseConfig?.apiKey || !firebaseConfig?.appId) {
  throw new Error(
    'Invalid Firebase configuration: projectId, apiKey, and appId are required in firebase-applet-config.json.'
  );
}

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);

const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';

let firestoreInstance;
try {
  // Auto-detect long polling ensures reliable Firestore connectivity inside sandboxed iframes
  firestoreInstance = initializeFirestore(
    app,
    { experimentalAutoDetectLongPolling: true },
    databaseId
  );
} catch {
  // Fallback if Firestore was already initialized on this FirebaseApp instance
  firestoreInstance = getFirestore(app, databaseId);
}

export const db = firestoreInstance;
