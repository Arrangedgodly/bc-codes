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
import {
  emailLogin,
  googleLogin,
  emailSignup,
  logout,
  getUserDocument,
} from "./firebase";
import { Routes, Route } from "react-router-dom";
import { ArtistProps } from "./types";
import { getAuth, onAuthStateChanged } from "firebase/auth";

const App = () => {
  const [theme, setTheme] = useState("dracula");
  const [user, setUser] = useState<ArtistProps | null>(null);

  const fetchUser = async () => {
    const auth = getAuth();
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const userDocument = await getUserDocument(user.uid);
        if (userDocument) {
          setUser(userDocument);
        }
      }
    });
  };

  useEffect(() => {
    themeChange(false);
    fetchUser();
  }, []);

  const handleThemeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTheme(event.target.checked ? "nord" : "dracula");
    themeChange(event.target.checked);
  };

  const handleEmailLogin = async (email: string, password: string) => {
    const user = await emailLogin(email, password);
    if (user) {
      setUser(user);
    }
  };

  const handleGoogleLogin = async () => {
    const user = await googleLogin();
    if (user) {
      setUser(user);
    }
  };

  const handleEmailSignup = async (email: string, password: string) => {
    const user = await emailSignup(email, password);
    if (user) {
      setUser(user);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    localStorage.removeItem("uid");
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
        <Route
          path="/login"
          element={
            <Login
              user={user}
              handleEmailLogin={handleEmailLogin}
              handleGoogleLogin={handleGoogleLogin}
            />
          }
        />
        <Route
          path="/signup"
          element={
            <Signup
              user={user}
              handleEmailSignup={handleEmailSignup}
              handleGoogleSignup={handleGoogleLogin}
            />
          }
        />
        <Route
          path="/profile"
          element={<Profile user={user} setUser={setUser} />}
        />
        <Route path="/settings" element={<Settings user={user} />} />
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
