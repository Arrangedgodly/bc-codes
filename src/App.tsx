import Header from "./components/Header";
import Artist from "./components/Artist";
import Footer from "./components/Footer";
import Shortcut from "./components/Shortcut";
import { agAlbums, cdcAlbums } from "./temp";
import { useState, useEffect } from "react";
import { themeChange } from 'theme-change';
import { User } from "firebase/auth";
import { emailLogin, googleLogin } from "./firebase";

const App = () => {
  const [theme, setTheme] = useState('dracula');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    themeChange(false)
  }, [])

  const handleThemeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTheme(event.target.checked ? 'nord' : 'dracula');
    themeChange(event.target.checked);
  }

  const handleEmailLogin = async (email: string, password: string) => {
    const user = await emailLogin(email, password);
    setUser(user);
  };

  const handleGoogleLogin = async () => {
    const user = await googleLogin();
    setUser(user);
  };

  return (
    <div data-theme={theme} className='font-amatic'>
      <Header theme={theme} handleThemeChange={handleThemeChange} user={user} />
      <div className="h-full w-full carousel carousel-center mx-auto">
        <Artist name="Arranged Godly" albums={agAlbums} />
        <Artist name="CDC_" albums={cdcAlbums} />
      </div>
      <Shortcut />
      <Footer />
    </div>
  );
}

export default App;
