import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { ArtistProps } from "./types";

const firebaseConfig = {
  apiKey: "AIzaSyAuOZMppl_i_395WP_5he4iDZ9CBl_QvmE",
  authDomain: "bc-codes-be8d1.firebaseapp.com",
  projectId: "bc-codes-be8d1",
  storageBucket: "bc-codes-be8d1.appspot.com",
  messagingSenderId: "243659815788",
  appId: "1:243659815788:web:a1d561b9f77c03b6a59149",
  measurementId: "G-33D4FGCCZT",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore();

async function emailLogin(
  email: string,
  password: string
): Promise<ArtistProps | null> {
  const auth = getAuth();
  try {
    const userCredential = await signInWithEmailAndPassword(
      auth,
      email,
      password
    );
    const user = userCredential.user;
    if (user) {
      const userDoc = await getUserDocument(user.uid);
      if (!userDoc) {
        await createUserDocument(user.uid);
      }
      return userDoc;
    }
    return null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function googleLogin(): Promise<ArtistProps | null> {
  const auth = getAuth();
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    if (user) {
      const userDoc = await getUserDocument(user.uid);
      if (!userDoc) {
        await createUserDocument(user.uid);
      }
      return userDoc;
    }
    return null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function logout(): Promise<void> {
  const auth = getAuth();
  try {
    await auth.signOut();
  } catch (error) {
    console.error(error);
  }
}

async function emailSignup(
  email: string,
  password: string
): Promise<ArtistProps | null> {
  const auth = getAuth();
  try {
    const userCredential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );
    const user = userCredential.user;
    if (user) {
      const userDoc = await getUserDocument(user.uid);
      if (!userDoc) {
        await createUserDocument(user.uid);
      }
      return userDoc;
    }
    return null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function getUserDocument(uid: string): Promise<ArtistProps | null> {
  const docRef = doc(db, "artists", uid);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data() as ArtistProps;
  }
  return null;
}

async function createUserDocument(uid: string): Promise<void> {
  const docRef = doc(db, "artists", uid);
  await setDoc(docRef, {
    uid,
    name: "",
    location: "",
    releases: [],
  });
}

async function updateUserName(uid: string, name: string): Promise<void> {
  const docRef = doc(db, "artists", uid);
  await setDoc(docRef, { name }, { merge: true });
}

async function updateUserLocation(
  uid: string,
  location: string
): Promise<void> {
  const docRef = doc(db, "artists", uid);
  await setDoc(docRef, { location }, { merge: true });
}

export { app, db, emailLogin, googleLogin, emailSignup, logout, getUserDocument, updateUserLocation, updateUserName };
