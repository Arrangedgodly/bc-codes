import Album from "./Album";

type AlbumProps = {
  name: string;
  image: string;
  link: string;
};

type ArtistProps = {
  name: string;
  albums: AlbumProps[];
};

const Artist: React.FC<ArtistProps> = ({ name, albums }) => {
  return (
    <div className="carousel-item h-screen w-full flex-col">
      <h1 className="text-6xl m-5 mx-auto font-bold mt-[10%]">{name}</h1>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        {albums.map((album) => (
          <Album name={album.name} image={album.image} link={album.link} />
        ))}
      </div>
    </div>
  );
};

export default Artist;
