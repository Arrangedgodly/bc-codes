type AlbumProps = {
  name: string;
  image: string;
};

const Album: React.FC<AlbumProps> = ({ name, image }) => {
  return (
    <div className="card w-1/5 bg-base-100 shadow-xl image-full m-5">
      <figure>
        <img src={image} alt={name} />
      </figure>
      <div className="justify-end card-body text-center">
        <h2 className="card-title m-auto">{name}</h2>
        <div className="flex-row card-actions">
          <button className="btn btn-secondary w-1/3 mx-auto">Bandcamp</button>
          <button className="btn btn-tertiary w-1/3 mx-auto">Generate Code</button>
        </div>
      </div>
    </div>
  );
};

export default Album;
