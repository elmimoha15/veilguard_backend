/**
 * Firebase CLIENT SDK helpers (as opposed to the Admin SDK). Requests made
 * through these are subject to firestore.rules — exactly what a browser hits.
 * Supports both anonymous and authenticated (Auth emulator) clients.
 */
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  type Auth,
} from 'firebase/auth';

let counter = 0;

export interface ClientHandle {
  db: Firestore;
  app: FirebaseApp;
  close: () => Promise<void>;
}

export interface AuthedClientHandle extends ClientHandle {
  uid: string;
  token: string;
  auth: Auth;
}

function newApp() {
  return initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-veilguard', apiKey: 'demo-key' }, `client-${++counter}`);
}

function connectFs(app: FirebaseApp): Firestore {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const [h, p] = host.split(':');
  const db = getFirestore(app);
  connectFirestoreEmulator(db, h || '127.0.0.1', Number(p || 8080));
  return db;
}

/** Unauthenticated client (request.auth == null). */
export function clientDb(): ClientHandle {
  const app = newApp();
  const db = connectFs(app);
  return { db, app, close: () => deleteApp(app) };
}

/**
 * Authenticated client: signs the user up (or in), so Firestore requests carry
 * request.auth.uid and the ID token is available for backend calls.
 */
export async function authedClient(email: string, password: string): Promise<AuthedClientHandle> {
  const app = newApp();
  const auth = getAuth(app);
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
  connectAuthEmulator(auth, authHost.startsWith('http') ? authHost : `http://${authHost}`, { disableWarnings: true });

  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, email, password);
  } catch {
    cred = await signInWithEmailAndPassword(auth, email, password);
  }
  const token = await cred.user.getIdToken();
  const db = connectFs(app);
  return { db, app, auth, uid: cred.user.uid, token, close: () => deleteApp(app) };
}

/** True if an error is a Firestore permission-denied. */
export function isPermissionDenied(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code === 'permission-denied' || /permission-denied|Missing or insufficient permissions/i.test(String((err as Error)?.message ?? ''));
}
