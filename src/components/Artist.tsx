import Album from "./Album";
import { ArtistProps } from "../types";

const Artist: React.FC<ArtistProps> = ({ name, location, releases }) => {
  return (
    <div className="carousel-item h-screen w-full flex-col">
      <h1 className="text-6xl m-5 mx-auto font-bold mt-[7%]">{name}</h1>
      <p className="text-3xl m-7 mt-3 mx-auto italic">{location}</p>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        {releases.map((album) => (
          <Album name={album.name} image={album.image} link={album.link} key={album.name} codes={album.codes} />
        ))}
      </div>
    </div>
  );
};

export default Artist;
