import Album from "./Album";

type AlbumProps = {
  name: string;
  image: string;
};

type ArtistProps = {
  name: string;
  albums: AlbumProps[];
};

const Artist: React.FC<ArtistProps> = ({ name, albums }) => {
  return (
    <div className="carousel-item h-screen w-full flex-col justify-center items-center">
      <h1 className="text-4xl m-5 mx-auto font-bold">{name}</h1>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        {albums.map((album) => (
          <Album name={album.name} image={album.image} />
        ))}
      </div>
    </div>
  );
};

export default Artist;
