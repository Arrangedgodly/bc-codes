import Artist from "./Artist";
import Shortcut from "./Shortcut";
import { agAlbums, cdcAlbums } from "../temp";

const Artists = () => {
  return (
    <div className="h-full w-full carousel carousel-center mx-auto">
      <Artist name="Arranged Godly" albums={agAlbums} />
      <Artist name="CDC_" albums={cdcAlbums} />
      <Shortcut />
    </div>
  );
};

export default Artists;
