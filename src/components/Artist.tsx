import Album from "./Album";
import { useEffect, useState } from "react";

type ArtistProps = {
  artist: any;
}

const Artist: React.FC<ArtistProps> = ({ artist }) => {
  const [sortedReleases, setSortedReleases] = useState<any[]>([]);

  useEffect(() => {
    const sorted = artist.releases.sort((a: any, b: any) => {
      return (
        new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime()
      );
    });
    setSortedReleases(sorted);
  }, [artist]);

  return (
    <div className="carousel-item min-h-[95vh] w-full flex-col">
      <h1 className="main-text m-5 mx-auto font-bold mt-[100px]">{artist.name}</h1>
      <p className="header-text m-7 mt-3 mx-auto italic">{artist.location}</p>
      <div className="flex flex-row flex-wrap gap-2 mx-auto justify-center mb-5">
        {sortedReleases.map((album) => (
          <Album
            key={album.name}
            name={album.name}
            artist={album.artist}
            codes={album.codes}
            image={album.image}
            link={album.link}
            releaseType={album.releaseType}
            slug={album.slug}
          />
        ))}
      </div>
    </div>
  );
};

export default Artist;
