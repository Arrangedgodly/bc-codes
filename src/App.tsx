import Header from "./components/Header";
import Artist from "./components/Artist";
import Footer from "./components/Footer";
import { agAlbums, cdcAlbums } from "./temp";

const App = () => {
  return (
    <>
      <Header />
      <div className="h-full w-full carousel carousel-center mx-auto">
        <Artist name="Arranged Godly" albums={agAlbums} />
        <Artist name="CDC_" albums={cdcAlbums} />
      </div>
      <Footer />
    </>
  );
}

export default App;
