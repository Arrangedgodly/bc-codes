import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, User, createUserWithEmailAndPassword } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAuOZMppl_i_395WP_5he4iDZ9CBl_QvmE",
  authDomain: "bc-codes-be8d1.firebaseapp.com",
  projectId: "bc-codes-be8d1",
  storageBucket: "bc-codes-be8d1.appspot.com",
  messagingSenderId: "243659815788",
  appId: "1:243659815788:web:a1d561b9f77c03b6a59149",
  measurementId: "G-33D4FGCCZT"
};

const app = initializeApp(firebaseConfig);

async function emailLogin(email: string, password: string): Promise<User | null> {
  const auth = getAuth();
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function googleLogin(): Promise<User | null> {
  const auth = getAuth();
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
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

async function emailSignup(email: string, password: string): Promise<User | null> {
  const auth = getAuth();
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error) {
    console.error(error);
    return null;
  }
}

export { app, emailLogin, googleLogin, emailSignup, logout };