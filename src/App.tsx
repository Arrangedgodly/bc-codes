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
import { Routes, Route, useNavigate } from "react-router-dom";
import { UserProps } from "./types";
import { getAuth, onAuthStateChanged } from "firebase/auth";

const App = () => {
  const [theme, setTheme] = useState("dracula");
  const [user, setUser] = useState<UserProps | null>(null);
  const [uid, setUid] = useState<string>("");
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
          navigate("/settings")
        }
      });
    }
  }, [uid]);

  useEffect(() => {
    if (user) {
      navigate("/");
    }}, [user]);

  const handleThemeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTheme(event.target.checked ? "nord" : "dracula");
    themeChange(event.target.checked);
  };

  const handleEmailLogin = async (email: string, password: string) => {
    const res = await emailLogin(email, password);
    return res;
  };

  const handleGoogleLogin = async () => {
    const res = await googleLogin();
    return res;
  };

  const handleEmailSignup = async (email: string, password: string) => {
    const res = await emailSignup(email, password);
    return res;
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
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
              setUser={setUser}
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
              setUser={setUser}
            />
          }
        />
        <Route
          path="/profile"
          element={<Profile user={user} setUser={setUser} />}
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
