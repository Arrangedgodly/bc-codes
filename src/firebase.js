import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth, signInWithEmailAndPassword, GoogleAuthProvider } from "firebase/auth";

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
const analytics = getAnalytics(app);

function emailLogin(email, password) {
  const auth = getAuth();
  signInWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      // Signed in
      const user = userCredential.user;
      console.log(user);
      // ...
    })
    .catch((error) => {
      const errorCode = error.code;
      const errorMessage = error.message;
    });
}

function googleLogin() {
  const auth = getAuth();
  const provider = new GoogleAuthProvider();

  signInWithPopup(auth, provider)
    .then((result) => {
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const token = credential.accessToken;
      const user = result.user;
      console.log(user);
    }).catch((error) => {
      const errorCode = error.code;
      const errorMessage = error.message;
      const email = error.email;
      const credential = GoogleAuthProvider.credentialFromError(error);
    });
}

export { emailLogin, googleLogin };