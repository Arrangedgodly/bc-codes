import Header from "./components/Header";
import Album from "./components/Album";

function App() {
  return (
    <>
      <Header />
      <div className="h-96 carousel carousel-vertical rounded-box mx-auto">
        <Album name="Taxed, Tolled & Eternally Trolled" image="https://f4.bcbits.com/img/a3758805720_10.jpg" />
        <Album name="Twizz-ed Up Loosies" image="https://f4.bcbits.com/img/a2352862029_10.jpg" />
      </div>
    </>
  );
}

export default App;
