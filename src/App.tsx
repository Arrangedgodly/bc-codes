import Header from "./components/Header";
import Artist from "./components/Artist";
import Footer from "./components/Footer";
import Shortcut from "./components/Shortcut";
import { agAlbums, cdcAlbums } from "./temp";
import { useState, useEffect } from "react";
import { themeChange } from 'theme-change';

const App = () => {
  const [theme, setTheme] = useState('dracula');

  useEffect(() => {
    themeChange(false)
  }, [])

  const handleThemeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTheme(event.target.checked ? 'nord' : 'dracula');
    themeChange(event.target.checked);
  }

  return (
    <div data-theme={theme}>
      <Header theme={theme} handleThemeChange={handleThemeChange} />
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
