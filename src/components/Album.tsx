type AlbumProps = {
  name: string;
  image: string;
  link: string;
};

const Album: React.FC<AlbumProps> = ({ name, image, link }) => {
  return (
    <div className="card w-1/4 bg-base-100 shadow-xl image-full m-5">
      <figure>
        <img src={image} alt={name} />
      </figure>
      <div className="justify-end card-body text-center">
        <h2 className="card-title m-auto text-4xl">{name}</h2>
        <div className="flex-row card-actions">
          <a
            href={link}
            target="_blank"
            className="btn btn-secondary w-[45%] mx-auto text-xl"
          >
            Bandcamp
          </a>
          <button className="btn btn-tertiary w-[45%] mx-auto text-xl">
            Generate Code
          </button>
        </div>
      </div>
    </div>
  );
};

export default Album;
