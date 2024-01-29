import Album from "./Album";
import { ArtistProps } from "../types";
import { useEffect, useState } from "react";

const Artist: React.FC<ArtistProps> = ({ name, location, releases }) => {
  const [sortedReleases, setSortedReleases] = useState<any[]>([]);

  useEffect(() => {
    const sorted = releases.sort((a, b) => {
      return (
        new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime()
      );
    });
    setSortedReleases(sorted);
  }, [releases]);

  return (
    <div className="carousel-item min-h-[95vh] w-full flex-col">
      <h1 className="main-text m-5 mx-auto font-bold mt-[125px]">{name}</h1>
      <p className="header-text m-7 mt-3 mx-auto italic">{location}</p>
      <div className="flex flex-row flex-wrap gap-2 mx-auto justify-center">
        {sortedReleases.map((album) => (
          <Album
            key={album.name}
            id={album.id}
            name={album.name}
            artist={album.artist}
            codes={album.codes}
            image={album.image}
            link={album.link}
            releaseType={album.releaseType}
          />
        ))}
      </div>
    </div>
  );
};

export default Artist;
