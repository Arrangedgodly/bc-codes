import Header from "./components/Header";
import Artist from "./components/Artist";
import Footer from "./components/Footer";

const agAlbums = [
  {
    name: "Taxed, Tolled & Eternally Trolled",
    image: "https://f4.bcbits.com/img/a3758805720_10.jpg",
  },
  {
    name: "Twizz-ed Up Loosies",
    image: "https://f4.bcbits.com/img/a2352862029_10.jpg",
  },
];

const cdcAlbums = [
  {
    name: "The Suicide Note: Stabber Highlife Vol. 2",
    image: "https://f4.bcbits.com/img/a3162885671_10.jpg",
  },
  {
    name: "An Exercise in Futility",
    image: "https://f4.bcbits.com/img/a3737176040_10.jpg",
  },
  {
    name: "Stabber Highlife",
    image: "https://f4.bcbits.com/img/a3883910810_10.jpg",
  },
];

function App() {
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
