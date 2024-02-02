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
  getDocs,
  addDoc,
  deleteDoc,
  collection,
  updateDoc,
} from "firebase/firestore";
import {
  UserProps,
  ArtistProps,
  ReleaseProps,
  NewReleaseProps,
  RedeemedProps,
  FanProps
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

async function emailLogin(email: string, password: string): Promise<void> {
  const auth = getAuth();
  await signInWithEmailAndPassword(auth, email, password);
}

async function googleLogin(): Promise<void> {
  const auth = getAuth();
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error(error);
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

async function emailSignup(email: string, password: string): Promise<void> {
  const auth = getAuth();
  await createUserWithEmailAndPassword(auth, email, password);
}

async function createUserDocument(uid: string, name: string, accountType: string): Promise<void> {
  const userRef = doc(db, "users", uid);
  await setDoc(userRef, { uid, name, accountType });
}

async function getUserDocument(uid: string): Promise<UserProps | null> {
  const docRef = doc(db, "users", uid);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data() as UserProps;
  }
  return null;
}

async function createArtistDocument(uid: string): Promise<void> {
  const docRef = doc(db, "artists", uid);
  await setDoc(docRef, {
    uid,
    name: "",
    location: "",
    releases: [],
    followers: [],
    genres: []
  });
}

async function getArtistDocument(uid: string): Promise<ArtistProps | null> {
  const docRef = doc(db, "artists", uid);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data() as ArtistProps;
  }
  return null;
}

async function getArtistDocumentBySlug(slug: string): Promise<ArtistProps | null> {
  const artistsRef = collection(db, "artists");
  const querySnapshot = await getDocs(artistsRef);
  const matchingArtists = querySnapshot.docs.filter(doc => doc.data().slug === slug);
  if (matchingArtists.length > 0) {
    return matchingArtists[0].data() as ArtistProps;
  }
  return null;
}

async function createFanDocument(uid: string): Promise<void> {
  const docRef = doc(db, "fans", uid);
  await setDoc(docRef, {
    uid,
    name: "",
    redeemed: [],
    following: [],
  });
}

async function getFanDocument(uid: string): Promise<FanProps | null> {
  const docRef = doc(db, "fans", uid);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data() as FanProps;
  }
  return null;
}

async function updateArtistName(uid: string, name: string): Promise<void> {
  const docRef = doc(db, "artists", uid);
  await setDoc(docRef, { name }, { merge: true });
}

async function updateArtistLocation(
  uid: string,
  location: string
): Promise<void> {
  const docRef = doc(db, "artists", uid);
  await setDoc(docRef, { location }, { merge: true });
}

async function updateArtistSlug(
  uid: string,
  slug: string
): Promise<void> {
  const docRef = doc(db, "artists", uid);
  await setDoc(docRef, { slug }, { merge: true });
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

async function getReleaseBySlug(slug: string): Promise<ReleaseProps | null> {
  const releasesRef = collection(db, "releases");
  const querySnapshot = await getDocs(releasesRef);
  const matchingReleases = querySnapshot.docs.filter(doc => doc.data().slug === slug);
  if (matchingReleases.length > 0) {
    return { id: matchingReleases[0].id, ...matchingReleases[0].data() } as ReleaseProps;
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

async function addCodeToFan(
  fanId: string,
  releaseId: string,
  code: string
): Promise<void> {
  const fanRef = doc(db, "fans", fanId);
  const fanDoc = await getDoc(fanRef);
  if (fanDoc.exists()) {
    const fanData = fanDoc.data() as FanProps;
    const redeemed = { releaseId, code };
    const updatedRedeemed = [...fanData.redeemed, redeemed];
    await updateDoc(fanRef, { redeemed: updatedRedeemed });
  }
}

async function getFanCodes(fanId: string): Promise<RedeemedProps[]> {
  const fanRef = doc(db, "fans", fanId);
  const fanDoc = await getDoc(fanRef);
  if (fanDoc.exists()) {
    const fanData = fanDoc.data() as FanProps;
    const redeemed = fanData.redeemed;
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
  createArtistDocument,
  getArtistDocument,
  getArtistDocumentBySlug,
  createFanDocument,
  getFanDocument,
  createUserDocument,
  getUserDocument,
  updateArtistLocation,
  updateArtistName,
  updateArtistSlug,
  addRelease,
  updateRelease,
  getRelease,
  getReleaseBySlug,
  removeRelease,
  removeReleaseFromArtist,
  getCode,
  removeCode,
  addCodeToFan,
  getFanCodes,
};
