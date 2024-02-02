import Header from "./components/Header";
import Artists from "./components/Artists";
import Login from "./components/Login";
import Signup from "./components/Signup";
import Profile from "./components/Profile";
import Settings from "./components/Settings";
import AlbumPage from "./components/AlbumPage";
import Footer from "./components/Footer";
import { useState, useEffect } from "react";
import { themeChange } from "theme-change";
import { logout, getUserDocument, getFanDocument, getArtistDocument } from "./firebase";
import { Routes, Route, useNavigate } from "react-router-dom";
import { UserProps } from "./types";
import { getAuth, onAuthStateChanged } from "firebase/auth";

const App = () => {
  const [theme, setTheme] = useState("dracula");
  const [user, setUser] = useState<UserProps | null>(null);
  const [uid, setUid] = useState<string>("");
  const [fanProfile, setFanProfile] = useState<any>(null);
  const [artistProfile, setArtistProfile] = useState<any>(null);
  const navigate = useNavigate();

  const fetchUser = async () => {
    const auth = getAuth();
    onAuthStateChanged(auth, async (u) => {
      if (u) {
        setUid(u.uid);
      } else {
        setUid("");
      }
    });
  };

  useEffect(() => {
    themeChange(false);
    fetchUser();
  }, []);

  useEffect(() => {
    if (uid) {
      getUserDocument(uid).then((res) => {
        console.log(res);
        if (res !== null) {
          setUser(res);
        } else {
          navigate("/settings");
        }
      });
    }
  }, [uid]);

  useEffect(() => {
    if (user) {
      handleProfileFetch();
    }
  }, [user]);

  const handleThemeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTheme(event.target.checked ? "nord" : "dracula");
    themeChange(event.target.checked);
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  const handleProfileFetch = async () => {
    if (user?.accountType === "Fan" || user?.accountType === "Both") {
      const fanData = await getFanDocument(user.uid);
      setFanProfile(fanData);
    }
    if (user?.accountType === "Artist" || user?.accountType === "Both") {
      const artistData = await getArtistDocument(user.uid);
      setArtistProfile(artistData);
    }
  };

  return (
    <div data-theme={theme} className="font-amatic">
      <Header
        theme={theme}
        handleThemeChange={handleThemeChange}
        user={user}
        handleLogout={handleLogout}
      />
      <Routes>
        <Route path="/" element={<Artists />} />
        <Route path="/login" element={<Login user={user} />} />
        <Route path="/signup" element={<Signup user={user} />} />
        <Route
          path="/profile"
          element={
            <Profile
              user={user}
              fanProfile={fanProfile}
              artistProfile={artistProfile}
              setArtistProfile={setArtistProfile}
            />
          }
        />
        <Route path="/settings" element={<Settings uid={uid} />} />
        <Route
          path="/release/:releaseId"
          element={<AlbumPage user={user} fetchUser={fetchUser} />}
        />
      </Routes>
      <Footer />
    </div>
  );
};

export default App;
