import Album from "./Album";
import { ArtistProps } from "../types";
import { useEffect, useState } from "react";

const Artist: React.FC<ArtistProps> = ({ name, location, releases }) => {
  const [sortedReleases, setSortedReleases] = useState<any[]>([]);

  useEffect(() => {
    const sorted = releases.sort((a, b) => {
      return new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime();
    });
    setSortedReleases(sorted);
  }, [releases]);

  return (
    <div className="carousel-item h-screen w-full flex-col">
      <h1 className="text-6xl m-5 mx-auto font-bold mt-[7%]">{name}</h1>
      <p className="text-3xl m-7 mt-3 mx-auto italic">{location}</p>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        {sortedReleases.map((album) => (
          <Album
            name={album.name}
            artist={album.artist}
            codes={album.codes}
            image={album.image}
            link={album.link}
            releaseDate={album.releaseDate}
            releaseType={album.releaseType}
          />
        ))}
      </div>
    </div>
  );
};

export default Artist;
