/**
 * Firebase CLIENT SDK helper (as opposed to the Admin SDK). Requests made
 * through this are subject to firestore.rules — exactly what an unauthenticated
 * browser would hit. Used to prove fix-locking and no-enumeration.
 */
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';

let counter = 0;

export interface ClientHandle {
  db: Firestore;
  app: FirebaseApp;
  close: () => Promise<void>;
}

export function clientDb(): ClientHandle {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const [h, p] = host.split(':');
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-veilguard', apiKey: 'demo-key' }, `client-${++counter}`);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, h || '127.0.0.1', Number(p || 8080));
  return { db, app, close: () => deleteApp(app) };
}

/** True if an error is a Firestore permission-denied. */
export function isPermissionDenied(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code === 'permission-denied' || /permission-denied|Missing or insufficient permissions/i.test(String((err as Error)?.message ?? ''));
}
