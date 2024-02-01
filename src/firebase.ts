import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  addDoc,
  deleteDoc,
  collection,
  updateDoc,
} from "firebase/firestore";
import {
  ArtistProps,
  ReleaseProps,
  NewReleaseProps,
  RedeemedProps,
} from "./types";

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
    } else {
      console.log("No user found")
      return null;
    }
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
        const newUserDoc = await getUserDocument(user.uid);
        return newUserDoc;
      } else {
        return userDoc;
      }
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
    redeemed: [],
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

async function addRelease(
  artistId: string,
  releaseData: NewReleaseProps
): Promise<void> {
  const releaseRef = await addDoc(collection(db, "releases"), releaseData);
  const artistRef = doc(db, "artists", artistId);
  const artistDoc = await getDoc(artistRef);

  if (artistDoc.exists()) {
    const artistData = artistDoc.data() as ArtistProps;
    const updatedReleases = [...artistData.releases, releaseRef.id];
    await updateDoc(artistRef, { releases: updatedReleases });
  } else {
    throw new Error("Artist document does not exist");
  }
}

async function updateRelease(
  releaseId: string,
  releaseData: ReleaseProps
): Promise<void> {
  const releaseRef = doc(db, "releases", releaseId);
  await updateDoc(releaseRef, releaseData);
}

async function getRelease(releaseId: string): Promise<ReleaseProps | null> {
  const releaseRef = doc(db, "releases", releaseId);
  const releaseDoc = await getDoc(releaseRef);
  if (releaseDoc.exists()) {
    return { id: releaseId, ...releaseDoc.data() } as ReleaseProps;
  }
  return null;
}

async function removeRelease(releaseId: string): Promise<void> {
  const releaseRef = doc(db, "releases", releaseId);
  await deleteDoc(releaseRef);
}

async function removeReleaseFromArtist(
  artistId: string,
  releaseId: string
): Promise<void> {
  const artistRef = doc(db, "artists", artistId);
  const artistDoc = await getDoc(artistRef);

  if (artistDoc.exists()) {
    const artistData = artistDoc.data() as ArtistProps;
    const releases = artistData.releases;
    const updatedReleases = releases.filter((id) => {
      if (typeof id === "string") {
        return id !== releaseId;
      }
    });

    await updateDoc(artistRef, { releases: updatedReleases });
  }
}

async function getCode(releaseId: string): Promise<string | null> {
  const releaseRef = doc(db, "releases", releaseId);
  const releaseDoc = await getDoc(releaseRef);

  if (releaseDoc.exists()) {
    const releaseData = releaseDoc.data() as ReleaseProps;
    const codes = releaseData.codes;

    if (codes.length > 0) {
      const code = codes[0];
      return code;
    }
  }

  return null;
}

async function removeCode(releaseId: string, code: string): Promise<void> {
  const releaseRef = doc(db, "releases", releaseId);
  const releaseDoc = await getDoc(releaseRef);

  if (releaseDoc.exists()) {
    const releaseData = releaseDoc.data() as ReleaseProps;
    const codes = releaseData.codes;
    const updatedCodes = codes.filter((c) => c !== code);

    await updateDoc(releaseRef, { codes: updatedCodes });
  }
}

async function addCodeToUser(
  artistId: string,
  releaseId: string,
  code: string
): Promise<void> {
  const artistRef = doc(db, "artists", artistId);
  const artistDoc = await getDoc(artistRef);
  if (artistDoc.exists()) {
    const artistData = artistDoc.data() as ArtistProps;
    const redeemed = { releaseId, code };
    const updatedRedeemed = [...artistData.redeemed, redeemed];
    await updateDoc(artistRef, { redeemed: updatedRedeemed });
  }
}

async function getUserCodes(artistId: string): Promise<RedeemedProps[]> {
  const artistRef = doc(db, "artists", artistId);
  const artistDoc = await getDoc(artistRef);
  if (artistDoc.exists()) {
    const artistData = artistDoc.data() as ArtistProps;
    const redeemed = artistData.redeemed;
    return redeemed;
  }
  return [];
}

export {
  app,
  db,
  emailLogin,
  googleLogin,
  emailSignup,
  logout,
  getUserDocument,
  updateUserLocation,
  updateUserName,
  addRelease,
  updateRelease,
  getRelease,
  removeRelease,
  removeReleaseFromArtist,
  getCode,
  removeCode,
  addCodeToUser,
  getUserCodes,
};
